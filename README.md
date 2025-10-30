# homey-smart-charging
A set of Homeyscripts to implement smart charging, much like the one found in Tibber.

## Tested with the following devices
- Tibber Pulse - real time electricity meter
- BMW cars - using the new CarData API

## Limitations
This solution does not take solar power into consideration, it only tries to charge the cars when its as cheap as possible. I also take **no responsibility** for blowing a fuse or three when charging due to the load balancing script not working or not acting fast enough.

## Variables needed to be created
These variables are needed in order for the scripts to work.

### Strings
| Variable          | Example Value  |
| ----------------- | -------------- |
|ChargeDepartureTime|06:00           |
|ChargePlanJson     |{...}           |
|ChargeStatus       |off_outside_plan|

### Number
| Variable                          | Example Value  |
| --------------------------------- | -------------- |
|Car_BatteryCapacity_<car_device_id>|86.0            |

You need to create a variable for each car you add to Homey with its corresponding device ID and their battery capacity. This is to calculate how many kWh to add and how many charging slots are needed.

### Booleans
| Variable  | Example Value  |
| --------- | -------------- |
|ChargeSmart|Yes             |

This variable can be used to bypass the smart charging functionality. By using the **Device Capabilities** App from the Homey AppStore, you can create a button which sets the ChargeSmart variable to true/false.

## Flows
You need to create flows that triggers each of the script in this repo. I have the following flows created. Please note that each script has a `CONFIG` section that needs to be reviewed and updated according to your installation.

### Smart Charging Execute
This Advanced Flow runs every 5 minutes and triggers the Homeyscript `charge-execute.js`.

### Smart Charging Planning
This Advanced Flow runs at 13:45 Swedish time since by then, tomorrow's electrical prices has been released by Nordpool. It then just triggers the Homeyscript `charge-calculate.js`.

### Smart Charging Load Balance
This Advanced Flow runs every 30 seconds and executes the Homeyscript `charge-loadbalance.js`. This should run as often as possible to avoid exceeding your main fuse. Since I have a Tibber Pulse device that measures current and that device reports every 10 s, I've chosen to run it every 30 s.
