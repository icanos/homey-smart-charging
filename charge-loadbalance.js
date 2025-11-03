const CONFIG = {
  // Chargers to be managed
  CHARGERS: [
    'charger-id-here'
  ],

  // Power meter configuration
  POWER_METER_NAME: 'Pulse',
  POWER_METER_CURRENT_POWER_CAP: 'measure_power',
  POWER_METER_CURRENT_L1: 'measure_current.L1',
  POWER_METER_CURRENT_L2: 'measure_current.L2',
  POWER_METER_CURRENT_L3: 'measure_current.L3',

  CHARGER_CURRENT_CAP: 'available_installation_current',
  CHARGER_ONOFF_CAP: 'charging_button',
  CHARGER_CURRENT_L1: 'measure_current.phase1',
  CHARGER_CURRENT_L2: 'measure_current.phase2',
  CHARGER_CURRENT_L3: 'measure_current.phase3',

  // Grid and charging
  PHASES: 3,
  SINGLE_PHASE_FUSE: 1, // 1, 2 or 3 (which fuse is used for a single phase charger)
  MAINS_FUSE_A: 25,
  MAX_CHARGE_A: 16,
  
  MIN_ACTIVE_A: 6,

  // marginal mot huvudsäkring
  SAFETY_HEADROOM_A: 4,

  VAR_PLAN: 'ChargePlanJson',
  VAR_CHARGING_STATUS: 'ChargeStatus'
};

async function getDeviceById(id) {
  return await Homey.devices.getDevice({ id });
}

async function getDeviceByName(name) {
  return Object.values(await Homey.devices.getDevices())
    .find(x => x.name === name);
}

async function getNumericCapability(device, capability, defaultValue = null) {
  try {
    if (device.capabilitiesObj?.[capability]?.value != null)
      return Number(device.capabilitiesObj[capability].value);
  }
  catch {
    // Nothing
  }

  return defaultValue;
}

async function getLogicVar(name) {
  const vars = await Homey.logic.getVariables();
  return Object.values(vars).find(v => v.name === name);
}

async function upsertLogicVar(name, value) {
  const vars = await Homey.logic.getVariables();
  const existing = Object.values(vars).find(v => v.name === name);
  if (existing) {
    await Homey.logic.updateVariable({ id: existing.id, variable: { name, type: 'string', value: String(value) } });
  } else {
    await Homey.logic.createVariable({ variable: { name, type: 'string', value: String(value) } });
  }
}

async function getPlan() {
  return JSON.parse((await getLogicVar(CONFIG.VAR_PLAN))?.value ?? "{}");
}

function isNowInPlannedSlot(slots, now = new Date()) {
  const t = now.getTime();
  return (slots ?? []).some(s => t >= new Date(s.start).getTime() && t < new Date(s.end).getTime());
}

async function sendPush(text) {
  const users = Object.values(await Homey.users.getUsers());

  await Homey.flow.runFlowCardAction({
    uri: "homey:flowcardaction:homey:manager:mobile:push_text",
    id: "homey:manager:mobile:push_text",
    args: { text, user: users[0] },
  });
}

// Only run the load balancing algo if we're charging the car
const chargeStatus = await getLogicVar(CONFIG.VAR_CHARGING_STATUS);
if (chargerStatus.value !== 'charging') return;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const plan = await getPlan();
const shouldCharge = isNowInPlannedSlot(plan.slots, new Date());

const meter = await getDeviceByName(CONFIG.POWER_METER_NAME);
const charger = await getDeviceById(plan.chargerId);

// Get current for all phases from meter
const meterCurrentL1 = await getNumericCapability(meter, CONFIG.POWER_METER_CURRENT_L1, 0) || 0;
const meterCurrentL2 = await getNumericCapability(meter, CONFIG.POWER_METER_CURRENT_L2, 0) || 0;
const meterCurrentL3 = await getNumericCapability(meter, CONFIG.POWER_METER_CURRENT_L3, 0) || 0;

// This is what the charger currently uses
const chargerL1 = await getNumericCapability(charger, CONFIG.CHARGER_CURRENT_L1 || 0) || 0;
const chargerL2 = await getNumericCapability(charger, CONFIG.CHARGER_CURRENT_L2 || 0) || 0;
const chargerL3 = await getNumericCapability(charger, CONFIG.CHARGER_CURRENT_L3 || 0) || 0;

// Current max set to the charger
const chargerCurrent = await getNumericCapability(charger, CONFIG.CHARGER_CURRENT_CAP, 0) || 0;

// Fuse limit - our set headroom
const fuseLimitA = Math.max(0, CONFIG.MAINS_FUSE_A - CONFIG.SAFETY_HEADROOM_A);

const baseL1 = Math.max(0, meterCurrentL1 - chargerL1);
const baseL2 = Math.max(0, meterCurrentL2 - chargerL2);
const baseL3 = Math.max(0, meterCurrentL3 - chargerL3);

const maxSetL1 = clamp(Math.floor(fuseLimitA - baseL1), 0, CONFIG.MAX_CHARGE_A);
const maxSetL2 = clamp(Math.floor(fuseLimitA - baseL2), 0, CONFIG.MAX_CHARGE_A);
const maxSetL3 = clamp(Math.floor(fuseLimitA - baseL3), 0, CONFIG.MAX_CHARGE_A);

let symmetricLimitA = Math.min(maxSetL1, maxSetL2, maxSetL3);
let targetA = clamp(symmetricLimitA, 0, CONFIG.MAX_CHARGE_A);

const overNow =
  meterCurrentL1 > fuseLimitA ||
  meterCurrentL2 > fuseLimitA ||
  meterCurrentL3 > fuseLimitA;

if (overNow) {
  // We are above the main fuse size (- headroom), we need to force the charger lower immediately.
  const needA_L1 = Math.floor(fuseLimitA - meterCurrentL1 + chargerL1);
  const needA_L2 = Math.floor(fuseLimitA - meterCurrentL2 + chargerL2);
  const needA_L3 = Math.floor(fuseLimitA - meterCurrentL3 + chargerL3);

  const emergencyLimit = Math.min(needA_L1, needA_L2, needA_L3);

  targetA = clamp(Math.min(targetA, emergencyLimit), 0, CONFIG.MAX_CHARGE_A);
}

// Minimize the number of small changes to the charge amps
if (Math.abs(targetA - chargerCurrent) < 1.0) {
  targetA = chargerCurrent;
}

if (targetA < CONFIG.MIN_ACTIVE_A) {
  await sendPush(
    `Det finns inte tillräckligt med tillgänglig ström för att smartladda, pausar laddning tills övrig förbrukning sjunker.`
  );

  targetA = 0;

  // Update the charging var
  await upsertLogicVar(CONFIG.VAR_CHARGING_STATUS, 'off_capacity');
}
else {
  const status = await getLogicVar(CONFIG.VAR_CHARGING_STATUS);

  if (status.value === 'off_capacity') {
    // We have capacity again, reset the var to off_outside_plan to allow the charger script to continue
    await upsertLogicVar(CONFIG.VAR_CHARGING_STATUS, 'off_outside_plan');
  }
}

console.log(maxSetL1, maxSetL2, maxSetL3, targetA, overNow);

// Compare maxSetL1, L2, L3 against the previous values, if changed, notify the user
let chargerLimits = {
  L1: CONFIG.MAX_CHARGE_A,
  L2: CONFIG.MAX_CHARGE_A,
  L3: CONFIG.MAX_CHARGE_A
};

const currentVar = await getLogicVar('ChargeCurrent');
if (currentVar && currentVar.value) {
  chargerLimits = JSON.parse(currentVar.value);
}

/*if (chargerLimits.L1 != maxSetL1 || chargerLimits.L2 != maxSetL2 || chargerLimits.L3 != maxSetL3) {
  await sendPush(
    `Lastbalanserar ${charger.name} då kapaciteten skiljer sig från inställd maxbelastning. Nya värden är ${maxSetL1}, ${maxSetL2}, ${maxSetL3} A.`
  );
}*/

await upsertLogicVar('ChargeCurrent', JSON.stringify({
  L1: maxSetL1,
  L2: maxSetL2,
  L3: maxSetL3
}));

// Load balance
await Homey.flow.runFlowCardAction({
  uri: `homey:flowcardaction:homey:device:${plan.chargerId}`,
  id: `homey:device:${plan.chargerId}:installation_current_control`,
  args: {
    current1: maxSetL1,
    current2: maxSetL2,
    current3: maxSetL3
  }
});
