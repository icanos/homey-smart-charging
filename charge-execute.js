const CONFIG = {
  VAR_PLAN: 'ChargePlanJson',
  VAR_CHARGING_STATUS: 'ChargeStatus',
  VAR_CHARGING_SMART: 'ChargeSmart'
};

async function getDeviceById(id) {
  return await Homey.devices.getDevice({ id });
}

async function getDeviceByName(name) {
  return Object.values(await Homey.devices.getDevices())
    .find(x => x.name === name);
}

function powerFromAmphere(maxAmp, phaseCount, voltage) {
  return (maxAmp * phaseCount * voltage) / 1000; // return in kW
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

async function getStringCapability(device, capability, defaultValue = null) {
  try {
    if (device.capabilitiesObj?.[capability]?.value != null)
      return device.capabilitiesObj[capability].value;
  }
  catch {
    // Nothing
  }

  return defaultValue;
}

async function getBooleanCapability(device, capability, defaultValue = false) {
  try {
    if (device.capabilitiesObj?.[capability]?.value != null)
      return Boolean(device.capabilitiesObj[capability].value);
  }
  catch {
    // Nothing
  }

  return defaultValue;
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

async function getLogicVar(name) {
  const vars = await Homey.logic.getVariables();
  return Object.values(vars).find(v => v.name === name);
}

async function getPlan() {
  return JSON.parse((await getLogicVar(CONFIG.VAR_PLAN))?.value ?? "{}");
}

function isNowInPlannedSlot(slots, now = new Date()) {
  const t = now.getTime();
  return (slots ?? []).some(s => t >= new Date(s.start).getTime() && t < new Date(s.end).getTime());
}

async function sendNotification(text) {
  await Homey.flow.runFlowCardAction({
    uri: "homey:flowcardaction:homey:manager:notifications:create_notification",
    id: "homey:manager:notifications:create_notification",
    args: { text },
  });
}

async function sendPush(text) {
  const users = Object.values(await Homey.users.getUsers());

  await Homey.flow.runFlowCardAction({
    uri: "homey:flowcardaction:homey:manager:mobile:push_text",
    id: "homey:manager:mobile:push_text",
    args: { text, user: users[0] },
  });
}

const plan = await getPlan();
const shouldCharge = isNowInPlannedSlot(plan.slots);
const smartCharging = Boolean((await getLogicVar(CONFIG.VAR_CHARGING_SMART)).value);

const charger = await getDeviceById(plan.chargerId);
const currentState = await getLogicVar(CONFIG.VAR_CHARGING_STATUS);

// Ensure that a car is connected
if ((await getBooleanCapability(charger, 'alarm_generic.car_connected')) === false) {
  // Nothing to do, no car connected to charger
  console.log('No car connected to charger.');
  return;
}

const chargeMode = await getStringCapability(charger, 'charge_mode', 'Unknown');

if (!shouldCharge && smartCharging) {
  // Stop charging
  await Homey.flow.runFlowCardAction({
    uri: `homey:flowcardaction:homey:device:${plan.chargerId}:stop_charging`,
    id: `homey:device:${plan.chargerId}:stop_charging`
  });

  if (currentState.value === "charging") {
    await sendPush(`Pausade laddning på grund av högt elpris.`);
  }

  await upsertLogicVar(CONFIG.VAR_CHARGING_STATUS, 'off_outside_plan');
  return;
}

if (currentState.value !== "charging") {
  await sendPush(`Startade smartladdning.`);

  // Set charger to charge
  await Homey.flow.runFlowCardAction({
    uri: `homey:flowcardaction:homey:device:${plan.chargerId}:start_charging`,
    id: `homey:device:${plan.chargerId}:start_charging`
  });
}

await upsertLogicVar(CONFIG.VAR_CHARGING_STATUS, "charging");
