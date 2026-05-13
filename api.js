'use strict';

// Homey SDK3 can deliver the request body in several shapes depending on
// the client (Homey app, iOS Shortcuts, curl, …).  normalizePayload tries
// each known location and returns a plain object.
function normalizePayload(input) {
  if (!input) return {};
  if (typeof input === 'string') {
    try { return JSON.parse(input); } catch (_) { return {}; }
  }
  if (Array.isArray(input)) return {};
  if (typeof input === 'object') {
    if (typeof input.body === 'string') {
      try { return JSON.parse(input.body); } catch (_) {}
    }
    if (typeof input.rawBody === 'string') {
      try { return JSON.parse(input.rawBody); } catch (_) {}
    }
    if (typeof input.value === 'string') {
      try { return JSON.parse(input.value); } catch (_) {}
    }
    return input;
  }
  return {};
}

module.exports = {
  async getStatus({ homey }) {
    return homey.app.getStatus();
  },

  async getPrices({ homey }) {
    return homey.app.getPrices();
  },

  async setTrip({ homey, body, query, params }) {
    const payload = {
      ...normalizePayload(body),
      ...normalizePayload(query),
      ...normalizePayload(params),
    };
    homey.app.log(`api.setTrip payload=${JSON.stringify(payload)}`);
    return homey.app.setTrip(payload);
  },

  // GET fallback used by iOS Shortcuts (can't easily POST JSON)
  async setTripGet({ homey, body, query, params }) {
    const payload = {
      ...normalizePayload(body),
      ...normalizePayload(query),
      ...normalizePayload(params),
    };
    return homey.app.setTrip(payload);
  },

  async deleteTrip({ homey }) {
    return homey.app.deleteTrip();
  },

  async postCalendarSync({ homey }) {
    return homey.app.syncCalendar();
  },

  async updateSettings({ homey, body, query, params }) {
    const payload = {
      ...normalizePayload(body),
      ...normalizePayload(query),
      ...normalizePayload(params),
    };
    homey.app.log(`api.updateSettings payload=${JSON.stringify(payload)}`);
    return homey.app.updateSettings(payload);
  },

};
