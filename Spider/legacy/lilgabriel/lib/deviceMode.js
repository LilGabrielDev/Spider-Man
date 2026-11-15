async function getDeviceMode() {
  try {
    const { getSettings } = await import('../database/config.js');
    const settings = await getSettings();
    const raw = String(settings?.device || process.env.DEVICE || 'default').trim().toLowerCase();
    if (raw === 'ios' || raw === 'iphone') return 'ios';
    if (raw === 'android') return 'android';
    return 'default';
  } catch {
    return 'default';
  }
}

module.exports = getDeviceMode;
module.exports.getDeviceMode = getDeviceMode;
module.exports.default = getDeviceMode;
