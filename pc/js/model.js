(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../miniprogram/utils/business'));
  else root.CampusModel = factory(root.CampusBusiness);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (business) {
  'use strict';
  function browserStorage(storage) {
    return { getStorageSync(key) { const text = storage.getItem(key); return text ? JSON.parse(text) : undefined; }, setStorageSync(key, value) { storage.setItem(key, JSON.stringify(value)); } };
  }
  function canTrade(state, outstanding, busy, connected) {
    return !!(connected && !busy && !outstanding && !state.pending && state.device && state.device.readerReady && state.device.storageReady !== false);
  }
  function buildCommand(kind, fields) { return business.makeOperation(kind, fields); }
  function deviceKey(state, fallback) { return state.device && (state.device.id || state.device.name) || fallback; }
  function previewLayout(card, settings) {
    const amount = business.money(card ? card.balanceCents : 3750);
    const configured = settings.fontSize || 16;
    const effective = amount.length * configured * 0.58 > 126 ? 16 : configured;
    return { amount, fontSize: effective, configured, name: card && card.name || '校园同学', number: card && card.cardNo || 10000001 };
  }
  return { browserStorage, canTrade, buildCommand, deviceKey, previewLayout };
});
