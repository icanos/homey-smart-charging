const CONFIG = {
  ELECTRICITY_PRICING_ZONE: 'SE3',
  
  // Chargers to be managed
  CHARGERS: [
    'charger-id-here'
  ],

  // Grid and charging
  PHASES: 3,
  MAX_CHARGE_A: 16,
  VOLTAGE: 230,
  CHARGING_EFFICIENCY: 0.90,

  // Planning
  DEPARTURE_AT: (async () => {
    let departureTime = (await getLogicVar(CONFIG.VAR_DEPARTURE_TIME)).value;
    if (!departureTime) {
      departureTime = "08:00";
    }
    
    const parts = departureTime.split(':');

    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(Number(parts[0]), Number(parts[1]), 0, 0);

    return d.toISOString();
  }),
  
  CALCULATE_PRICE: ((price) => {
    return ((price * 1.25) + 0.3 + 0.09);
  }),

  // minsta sammanhängande ON-block (minuter)
  MIN_ON_BLOCK_MIN: 30,

  // om sista prisraden saknar "nästa", anta denna längd
  INTERVAL_MIN_FALLBACK: 60,

  VAR_PLAN: 'ChargePlanJson',
  VAR_DEPARTURE_TIME: 'ChargeDepartureTime'
};

const log = (...a) => console.log('[electrfy]', ...a);

async function getLogicVar(name) {
  const vars = await Homey.logic.getVariables();
  return Object.values(vars).find(v => v.name === name);
}

async function getDeviceById(id) {
  return await Homey.devices.getDevice({ id });
}

async function getCars() {
  const devices = Object.values(await Homey.devices.getDevices())
    .filter((dev) => dev.capabilities.find(cap => cap === 'range_capability'));

  return devices;
}

async function getBatteryCapacity(cars) {
  const variables = Object.values(await Homey.logic.getVariables());

  const capacities = {};

  for (const car of cars) {
    // Car_BatteryCapacity_616495cd-8aa1-44c5-86b6-3ad3f8d26acc
    const variable = variables.find((v) => v.name === `Car_BatteryCapacity_${car.id}`);
    capacities[car.id] = variable?.value ?? 0;
  }

  return capacities;
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

function hoursBetween(a, b) {
  return (new Date(b) - new Date(a)) / 3600000;
}

async function calculateNeededEnergy(car, capacities, targetPercentage = 80) {
  // Find what car is plugged in (if possible)
  const fullyChargedCapacity = capacities[car.id];
  const currentBatteryPercentage = Number(car.capabilitiesObj['measure_battery'].value) / 100.0;

  const currentKwh = fullyChargedCapacity * currentBatteryPercentage;
  console.log('Car ' + car.name + ' currently has ' + currentKwh + ' kWh in the battery.');
  const targetKwh = capacities[car.id] * (targetPercentage / 100);
  const difference = targetKwh - currentKwh;

  const toAdd = difference * ((1 - CONFIG.CHARGING_EFFICIENCY) + 1.0);
  log(toAdd, 'kWh are needed to be drawn from grid/elsewhere, car needs', difference);

  return toAdd;
}

function powerFromAmphere(maxAmp, phaseCount, voltage) {
  return (maxAmp * phaseCount * voltage) / 1000; // return in kW
}

async function getElectricityPrices(tomorrow = false) {
  const date = new Date();

  if (tomorrow) {
    date.setDate(date.getDate() + 1);
  }

  const year = date.getFullYear();
  let month = (date.getMonth() + 1).toString();
  let day = date.getDate().toString();

  if (month.length < 2) month = `0${month}`;
  if (day.length < 2) day = `0${day}`;

  const url = `https://www.elprisetjustnu.se/api/v1/prices/${year}/${month}-${day}_${CONFIG.ELECTRICITY_PRICING_ZONE}.json`;
  const res = await fetch(url);

  try {
    if (!res.ok) {
      throw new Error(res.statusText);
    }

    // Get the body JSON
    return await res.json();
  }
  catch {
    log("Elpriserna är inte släppta för dagen ännu.");
    return [];
  }
}

function planCheapestIntervals(prices, windowStartIso, windowEndIso, neededKwh, maxKw, minNumBlocks) {
  const ws = new Date(windowStartIso), we = new Date(windowEndIso);
  const within = prices.filter(p => new Date(p.time_end) >= ws && new Date(p.time_start) <= we)
    .map((p, idx) => {
      const s = new Date(Math.max(new Date(p.time_start), ws));
      const e = new Date(Math.min(new Date(p.time_end), we));
      const minutes = Math.max(0, Math.round((e - s) / 60000));
      const hours = minutes / 60;

      return {
        ...p,
        idx,
        start: s.toISOString(),
        end: e.toISOString(),
        minutes,
        hours
      };
    })
    .filter(p => p.minutes > 0);
  
  if (!within.length) return { slots: [], note: 'Inga prisintervall inom fönstret' };

  const withCap = within.map(p => ({
    ...p,
    kWh_at_max: maxKw * p.hours
  }));

  // Sortera efter pris (lägst först)
  withCap.sort((a,b) => a.SEK_per_kWh - b.SEK_per_kWh);

  const chosenIdx = new Set();
  let accKWh = 0;
  for (const p of withCap) {
    if (accKWh >= neededKwh) break;
    chosenIdx.add(p.idx + ':' + p.start); // idx+start för unikt ID efter klippning
    accKWh += p.kWh_at_max;
  }

  // Om inget valt, välj billigaste ändå (0 behov?)
  if (!chosenIdx.size) chosenIdx.add(withCap[0].idx + ':' + withCap[0].start);

  // Hjälpfunktion: bygg block av sammanhängande intervall (utan lucka)
  function contiguousBlocks(list) {
    // sortera på starttid
    const sorted = [...list].sort((a,b) => new Date(a.start) - new Date(b.start));
    const blocks = [];
    let cur = [sorted[0]];

    for (let i=1; i < sorted.length; i++) {
      const prevEnd = new Date(cur[cur.length-1].end).getTime();
      const thisStart = new Date(sorted[i].start).getTime();

      if (thisStart === prevEnd) {
        cur.push(sorted[i]);
      } else {
        blocks.push(cur); cur = [sorted[i]];
      }
    }

    blocks.push(cur);

    return blocks;
  }

  // Bygg lista av valda intervallobjekt
  const chosenList = within.filter(iv => chosenIdx.has(iv.idx + ':' + iv.start));

  // Uppfyll minsta blocklängd genom att expandera intilliggande intervall om möjligt
  let blocks = contiguousBlocks(chosenList);
  const minBlockMs = minNumBlocks * 60000;

  // Skapa snabb lookup by start/end för expansion
  const byStart = new Map(within.map(iv => [iv.start, iv]));
  const byEnd = new Map(within.map(iv => [iv.end, iv]));

  for (let b = 0; b < blocks.length; b++) {
    let block = blocks[b];
    let durationMs = new Date(block[block.length - 1].end) - new Date(block[0].start);
    if (durationMs >= minBlockMs) continue;

    // Expandera: först vänster, sen höger, om det finns granne och inte redan valt
    while (durationMs < minBlockMs) {
      let expanded = false;

      // vänster granne
      const leftCandidate = byEnd.get(block[0].start);
      if (leftCandidate && !chosenIdx.has(leftCandidate.idx + ':' + leftCandidate.start)) {
        block.unshift(leftCandidate);
        chosenIdx.add(leftCandidate.idx + ':' + leftCandidate.start);
        accKWh += leftCandidate.kWh_at_max;
        expanded = true;
      }

      // höger granne
      const rightCandidate = byStart.get(block[block.length-1].end);
      if (rightCandidate && !chosenIdx.has(rightCandidate.idx + ':' + rightCandidate.start)) {
        block.push(rightCandidate);
        chosenIdx.add(rightCandidate.idx + ':' + rightCandidate.start);
        accKWh += rightCandidate.kWh_at_max;
        expanded = true;
      }

      durationMs = new Date(block[block.length - 1].end) - new Date(block[0].start);
      if (!expanded) break;
    }

    blocks[b] = block;
  }

   // Trimma om vi råkat välja *väldigt* mycket mer än behövt:
  // (valfritt steg; vi låter ofta överskott vara kvar för enkelhetens skull)
  const finalChosen = within.filter(iv => chosenIdx.has(iv.idx + ':' + iv.start));
  finalChosen.sort((a,b) => new Date(a.start) - new Date(b.start));

  return {
    slots: finalChosen.map(iv => ({
      start: iv.start,
      end: iv.end,
      minutes: iv.minutes,
      price: CONFIG.CALCULATE_PRICE(iv.SEK_per_kWh)
    })),
    note: null
  };
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

const windowStart = new Date(); windowStart.setHours(21, 0, 0, 0);
const windowEnd = new Date(await CONFIG.DEPARTURE_AT());

// Get cars
const cars = await getCars();

// Get the battery capacity for that car
const capacities = await getBatteryCapacity(cars);
let prices = [
  ...await getElectricityPrices(),    // today
  ...await getElectricityPrices(true) // tomorrow
];

// Find out which car is connected to a charger
// NOTE (251121): Reworked this to always assume we've connected the car with the lowest battery percentage.
// This is done so that we make sure that even though, another car was connected, we're ensuring
// that any car connected will be charged to the correct level. This however, introduces the possibility that 
// the cost of charging won't be the absolute lowest.

// In my case, BMW sucks, and has limited their API so that we can't rely on it to determine if the car is
// connected to a charger or not. Therefore I've had to introduce this. I have however implemented it as a feature flag.
const featureProbeConnectionStatus = false;

for (const chargerId of CONFIG.CHARGERS) {
  const charger = await getDeviceById(chargerId);

  // Is any car connected to the charger?
  const connected = charger.capabilitiesObj['alarm_generic.car_connected'].value;
  if (!connected) continue;

  let cars = Object.values(await Homey.devices.getDevices())
    .filter((dev) => dev.class === 'car');

  let connectedCars = cars;

  if (featureProbeConnectionStatus) {
    connectedCars = cars
      .filter((car) => car.capabilitiesObj['ev_charging_state'].value !== 'plugged_out');

    if (connectedCars.length === 0) {
      console.log("No car seems to be plugged in. Will use the one with the lowest battery percentage to calculate energy that needs to be added. This might not work reliably!");

      cars = cars
        .sort((a, b) => Number(a.capabilitiesObj['measure_battery'].value) - Number(b.capabilitiesObj['measure_battery'].value));
      connectedCars = [cars[0]];
      console.log(cars);
    }
  }
  else {
    // Find the car with the lowest battery percentage
    connectedCars = connectedCars
      .sort((a, b) => Number(a.capabilitiesObj['measure_battery'].value) - Number(b.capabilitiesObj['measure_battery'].value));
  }

  const car = connectedCars[0];

  const neededEnergy = await calculateNeededEnergy(car, capacities);
  const maxKilowattPower = powerFromAmphere(CONFIG.MAX_CHARGE_A, CONFIG.PHASES, CONFIG.VOLTAGE);

  const plan = planCheapestIntervals(
    prices,
    windowStart.toISOString(),
    windowEnd.toISOString(),
    neededEnergy,
    maxKilowattPower,
    CONFIG.MIN_ON_BLOCK_MIN
  );

  // Summera planerad energi & ungefärlig kostnad (informativt)
  const plannedEnergyKWh = plan.slots.reduce((sum, s) => sum + maxKilowattPower * (s.minutes / 60), 0);
  const approxCost = plan.slots.reduce((sum, s) => sum + s.price * maxKilowattPower * (s.minutes / 60), 0);

  const planObj = {
    generatedAt: new Date().toISOString(),
    departureAt: new Date(await CONFIG.DEPARTURE_AT()).toISOString(),
    chargerId: chargerId,
    neededEnergy: Number(neededEnergy.toFixed(2)),
    plannedEnergyKwh: Number(plannedEnergyKWh.toFixed(2)),
    approxCost: Number(approxCost.toFixed(2)),
    maxKw: Number(maxKilowattPower.toFixed(2)),
    currentSoC: car.capabilitiesObj['measure_battery'].value,
    intervalFallbackMin: CONFIG.INTERVAL_MIN_FALLBACK,
    slots: plan.slots, // [{start,end,minutes,price}]
    note: plan.note
  };

  await upsertLogicVar(CONFIG.VAR_PLAN, JSON.stringify(planObj));
}
