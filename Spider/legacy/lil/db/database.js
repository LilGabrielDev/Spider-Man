import {
  getSettingsSync,
  updateSettingSync,
  getGroupSettingsSync,
  updateGroupSettingSync,
} from '../../lilgabriel/database/config.js';

export function getGroupSettings(groupJid) {
  return getGroupSettingsSync(groupJid);
}

export function setGroupSetting(groupJid, key, value) {
  return updateGroupSettingSync(groupJid, key, value);
}

export function updateGroupSetting(groupJid, key, value) {
  return updateGroupSettingSync(groupJid, key, value);
}

export function getSettings() {
  return getSettingsSync();
}

export function updateSetting(key, value) {
  return updateSettingSync(key, value);
}

export default {
  getGroupSettings,
  setGroupSetting,
  updateGroupSetting,
  getSettings,
  updateSetting,
};
