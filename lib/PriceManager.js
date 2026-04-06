'use strict';

const https = require('https');

class PriceManager {
  constructor(homey) {
    this.homey = homey;
    this._cache = {};
  }

  /**
   * Fetches prices for a given date and area.
   * Returns array of { time_start: Date, time_end: Date, price: SEK/kWh }
   * After 2025-10-01: 96 entries (15-min slots). Before: 24 entries (hourly).
   */
  async getPricesForDate(date, area) {
    const key = this._dateKey(date) + '_' + area;
    if (this._cache[key]) return this._cache[key];

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const url = `https://www.elprisetjustnu.se/api/v1/prices/${yyyy}/${mm}-${dd}_${area}.json`;

    const raw = await this._fetch(url);
    const prices = raw.map(entry => ({
      time_start: new Date(entry.time_start),
      time_end: new Date(entry.time_end),
      price: entry.SEK_per_kWh,
    }));

    this._cache[key] = prices;
    return prices;
  }

  /**
   * Returns prices for: 3 days back + today + tomorrow (if available).
   * Used to calculate the 5-day rolling average.
   */
  async get5DayPrices(area) {
    const today = this._startOfDay(new Date());
    const results = [];

    for (let offset = -3; offset <= 1; offset++) {
      const d = new Date(today);
      d.setDate(today.getDate() + offset);
      try {
        const prices = await this.getPricesForDate(d, area);
        results.push(...prices);
      } catch (e) {
        if (offset === 1) {
          this.homey.log('Tomorrow prices not available yet');
        } else {
          this.homey.log(`Could not fetch prices for offset ${offset}:`, e.message);
        }
      }
    }

    return results;
  }

  /**
   * Returns the 5-day rolling average price in SEK/kWh.
   */
  async get5DayAverage(area) {
    const prices = await this.get5DayPrices(area);
    if (prices.length === 0) return null;
    return prices.reduce((sum, p) => sum + p.price, 0) / prices.length;
  }

  /**
   * Returns all future price slots: from now until end of tomorrow.
   */
  async getFuturePrices(area) {
    const now = new Date();
    const prices = await this.get5DayPrices(area);
    return prices.filter(p => p.time_start >= now).sort((a, b) => a.time_start - b.time_start);
  }

  /**
   * Returns price slots from now until the given end time.
   */
  async getPricesUntil(area, endTime) {
    const now = new Date();
    const prices = await this.get5DayPrices(area);
    return prices
      .filter(p => p.time_start >= now && p.time_start < endTime)
      .sort((a, b) => a.time_start - b.time_start);
  }

  /**
   * Returns the price entry for the current 15-minute slot.
   */
  async getCurrentSlotPrice(area) {
    const prices = await this.get5DayPrices(area);
    return prices.find(p => this.isCurrentSlot(p)) || null;
  }

  /**
   * Returns true if the price entry covers the current moment.
   */
  isCurrentSlot(priceEntry) {
    const now = new Date();
    return priceEntry.time_start <= now && now < priceEntry.time_end;
  }

  /**
   * Classifies a price relative to the 5-day average.
   * Returns: 'VERY_CHEAP' | 'CHEAP' | 'OK' | 'EXPENSIVE'
   */
  classifyPrice(price, avg5day) {
    if (price < 0.10) return 'VERY_CHEAP';
    if (avg5day && price < avg5day * 0.75) return 'CHEAP';
    if (avg5day && price < avg5day) return 'OK';
    return 'EXPENSIVE';
  }

  /**
   * Returns the N cheapest price slots from a list.
   */
  cheapestSlots(prices, n) {
    return [...prices].sort((a, b) => a.price - b.price).slice(0, n);
  }

  clearCache() {
    this._cache = {};
  }

  _startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  _dateKey(date) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  _fetch(url) {
    return new Promise((resolve, reject) => {
      https.get(url, res => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }
}

module.exports = PriceManager;
