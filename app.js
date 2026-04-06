'use strict';

const Homey = require('homey');
const PriceManager = require('./lib/PriceManager');
const { Scheduler } = require('./lib/Scheduler');

const DEFAULT_SETTINGS = {
  area: 'SE3',
  floor: 25,
  normalTarget: 50,
  autoCharge: true,
};

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

class TeslaSmartChargingApp extends Homey.App {
  async onInit() {
    this.log('Tesla Smart Charging starting...');

    this._priceManager = new PriceManager(this.homey);
    this._nextTrip = null;
    this._lastCharging = null;
    this._lastDecision = null;

    this._registerFlowCards();
    this._registerApiRoutes();
    this._restoreTrip();

    // Clear price cache at midnight
    this.homey.setInterval(() => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() < 15) {
        this._priceManager.clearCache();
        this.log('Price cache cleared');
      }
    }, INTERVAL_MS);

    // Run immediately, then every 15 minutes
    await this._runScheduler();
    this.homey.setInterval(() => {
      this._runScheduler().catch(e => this.error('Scheduler error:', e));
    }, INTERVAL_MS);
  }

  async _runScheduler() {
    const settings = this._getSettings();
    if (!settings.autoCharge) {
      this.log('Auto charge disabled, skipping');
      return;
    }

    let currentBattery;
    try {
      currentBattery = await this._getTeslaBattery();
    } catch (e) {
      this.error('Could not read Tesla battery:', e.message);
      return;
    }

    const area = settings.area;

    let currentSlot, avg5day, futurePrices;
    try {
      [currentSlot, avg5day, futurePrices] = await Promise.all([
        this._priceManager.getCurrentSlotPrice(area),
        this._priceManager.get5DayAverage(area),
        this._priceManager.getFuturePrices(area),
      ]);
    } catch (e) {
      this.error('Could not fetch prices:', e.message);
      return;
    }

    const scheduler = new Scheduler({
      currentBattery,
      floor: settings.floor,
      normalTarget: settings.normalTarget,
      nextTrip: this._nextTrip,
      currentSlot,
      avg5day,
      futurePrices,
      priceManager: this._priceManager,
    });

    const decision = scheduler.decide();
    this.log(
      `Decision: shouldCharge=${decision.shouldCharge}, target=${decision.target}%, ` +
      `battery=${currentBattery}%, reason=${decision.reason}, ` +
      `price=${currentSlot ? currentSlot.price.toFixed(4) : 'n/a'} SEK/kWh, ` +
      `5d-avg=${avg5day ? avg5day.toFixed(4) : 'n/a'}`
    );

    try {
      await this._setTeslaCharging(decision.shouldCharge);
    } catch (e) {
      this.error('Could not set Tesla charging state:', e.message);
      return;
    }

    // Flow triggers on state transitions
    if (decision.shouldCharge && this._lastCharging === false) {
      this._triggerCard('cheap_charging_started').catch(e => this.error(e));
    }
    if (!decision.shouldCharge && this._lastCharging === true) {
      this._triggerCard('cheap_charging_ended').catch(e => this.error(e));
    }
    if (decision.reason === 'below_floor' && this._lastCharging !== true) {
      this._triggerCard('emergency_charging_activated').catch(e => this.error(e));
    }

    this._lastCharging = decision.shouldCharge;
    this._lastDecision = {
      ...decision,
      currentBattery,
      currentPrice: currentSlot ? currentSlot.price : null,
      avg5day,
      updatedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Tesla device
  // ---------------------------------------------------------------------------

  // App: "Tesla bil och energi" by Ronny Winkler (com.tesla.car)
  // Car driver:     measure_battery (read battery %)
  // Battery driver: charging_on (start/stop charging)

  async _getTeslaCarDevice() {
    const devices = await this.homey.devices.getDevices();
    const car = Object.values(devices).find(
      d => d.driverUri && d.driverUri.includes('com.tesla.car') && d.driverId === 'car'
    );
    if (!car) throw new Error('No Tesla car device found (com.tesla.car / driver: car)');
    return car;
  }

  async _getTeslaBatteryDevice() {
    const devices = await this.homey.devices.getDevices();
    const bat = Object.values(devices).find(
      d => d.driverUri && d.driverUri.includes('com.tesla.car') && d.driverId === 'battery'
    );
    if (!bat) throw new Error('No Tesla battery device found (com.tesla.car / driver: battery)');
    return bat;
  }

  async _getTeslaBattery() {
    const car = await this._getTeslaCarDevice();
    const cap = car.capabilitiesObj && car.capabilitiesObj['measure_battery'];
    if (!cap) throw new Error('measure_battery capability not found on Tesla car device');
    return cap.value;
  }

  async _setTeslaCharging(enabled) {
    const bat = await this._getTeslaBatteryDevice();
    await bat.setCapabilityValue('charging_on', enabled);
    this.log(`Tesla charging_on set to: ${enabled}`);
  }

  // ---------------------------------------------------------------------------
  // Flow cards
  // ---------------------------------------------------------------------------

  _registerFlowCards() {
    this._cheapChargingStarted = this.homey.flow.getTriggerCard('cheap_charging_started');
    this._cheapChargingEnded = this.homey.flow.getTriggerCard('cheap_charging_ended');
    this._emergencyChargingActivated = this.homey.flow.getTriggerCard('emergency_charging_activated');

    this.homey.flow
      .getConditionCard('is_cheap_electricity')
      .registerRunListener(async () => {
        const settings = this._getSettings();
        const [slot, avg] = await Promise.all([
          this._priceManager.getCurrentSlotPrice(settings.area),
          this._priceManager.get5DayAverage(settings.area),
        ]);
        if (!slot) return false;
        const tier = this._priceManager.classifyPrice(slot.price, avg);
        return tier === 'CHEAP' || tier === 'VERY_CHEAP';
      });

    this.homey.flow
      .getActionCard('set_next_trip')
      .registerRunListener(async args => {
        this._setTrip(new Date(args.departureTime), args.targetPercent);
        await this._runScheduler();
      });
  }

  async _triggerCard(id) {
    await this.homey.flow.getTriggerCard(id).trigger();
  }

  // ---------------------------------------------------------------------------
  // Webhook API
  // ---------------------------------------------------------------------------

  _registerApiRoutes() {
    this.homey.api.registerGetHandler('/status', async () => {
      const settings = this._getSettings();
      let battery = null;
      try { battery = await this._getTeslaBattery(); } catch (_) {}
      return {
        battery,
        lastDecision: this._lastDecision,
        nextTrip: this._nextTrip
          ? { departureTime: this._nextTrip.departureTime.toISOString(), targetPercent: this._nextTrip.targetPercent }
          : null,
        settings,
      };
    });

    this.homey.api.registerGetHandler('/prices', async () => {
      const settings = this._getSettings();
      const [prices, avg] = await Promise.all([
        this._priceManager.getFuturePrices(settings.area),
        this._priceManager.get5DayAverage(settings.area),
      ]);
      return {
        avg5day: avg,
        prices: prices.map(p => ({
          time_start: p.time_start.toISOString(),
          time_end: p.time_end.toISOString(),
          price: p.price,
          tier: this._priceManager.classifyPrice(p.price, avg),
          current: this._priceManager.isCurrentSlot(p),
        })),
      };
    });

    this.homey.api.registerPostHandler('/trip', async body => {
      const { departureTime, targetPercent } = body;
      if (!departureTime || targetPercent == null) throw new Error('departureTime and targetPercent required');
      const dep = new Date(departureTime);
      if (isNaN(dep.getTime())) throw new Error('Invalid departureTime');
      const pct = Number(targetPercent);
      if (pct < 20 || pct > 100) throw new Error('targetPercent must be 20–100');
      this._setTrip(dep, pct);
      this._runScheduler().catch(e => this.error(e));
      return { ok: true, trip: { departureTime: dep.toISOString(), targetPercent: pct } };
    });

    this.homey.api.registerDeleteHandler('/trip', async () => {
      this._nextTrip = null;
      this.homey.settings.set('nextTrip', null);
      this._runScheduler().catch(e => this.error(e));
      return { ok: true };
    });

    this.homey.api.registerPostHandler('/settings', async body => {
      const allowed = ['area', 'floor', 'normalTarget', 'autoCharge'];
      const current = this._getSettings();
      for (const key of allowed) {
        if (body[key] !== undefined) current[key] = body[key];
      }
      this.homey.settings.set('appSettings', current);
      return { ok: true, settings: current };
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _setTrip(departureTime, targetPercent) {
    this._nextTrip = { departureTime, targetPercent };
    this.homey.settings.set('nextTrip', {
      departureTime: departureTime.toISOString(),
      targetPercent,
    });
    this.log(`Trip set: ${departureTime.toISOString()} @ ${targetPercent}%`);
  }

  _restoreTrip() {
    const stored = this.homey.settings.get('nextTrip');
    if (stored && stored.departureTime) {
      const dep = new Date(stored.departureTime);
      if (dep > new Date()) {
        this._nextTrip = { departureTime: dep, targetPercent: stored.targetPercent };
        this.log(`Restored trip: ${dep.toISOString()} @ ${stored.targetPercent}%`);
      }
    }
  }

  _getSettings() {
    const stored = this.homey.settings.get('appSettings') || {};
    return { ...DEFAULT_SETTINGS, ...stored };
  }
}

module.exports = TeslaSmartChargingApp;
