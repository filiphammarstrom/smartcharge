'use strict';

// Homey SDK 3: API routes are handled here, not via homey.api.registerGetHandler.
// Function names match the keys in app.json "api" object.
// Access the App instance via homey.app.

module.exports = {
  async getStatus({ homey }) {
    return homey.app.apiGetStatus();
  },

  async getPrices({ homey }) {
    return homey.app.apiGetPrices();
  },

  async postTrip({ homey, body }) {
    return homey.app.apiPostTrip(body);
  },

  async deleteTrip({ homey }) {
    return homey.app.apiDeleteTrip();
  },

  async postSettings({ homey, body }) {
    return homey.app.apiPostSettings(body);
  },

  async postCalendarSync({ homey }) {
    homey.app._syncCalendar().catch(e => homey.app.error('Calendar sync error:', e));
    return { ok: true, message: 'Kalendersynk startad' };
  },
};
