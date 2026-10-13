interface DevicePlatform {
  isDesktopApp: boolean;
  isMobileApp: boolean;
  isIosApp: boolean;
  isPhone: boolean;
  isTablet: boolean;
}

interface DeviceScreen {
  width: number;
  height: number;
}

/** Choose once from device facts, never from a view's resizable viewport.
 * Browsers do not expose whether a stylus is paired. Mobile tablets are the
 * handwriting-first exception; desktops and unknown devices start reading.
 */
export function defaultReadingMode(platform: DevicePlatform, device: DeviceScreen): boolean {
  if (platform.isDesktopApp || !platform.isMobileApp) return true;
  const shortEdge = Math.min(device.width, device.height);
  // iPad split windows can report phone-sized UI while Platform.isIosApp and
  // the device screen still identify the tablet-sized device.
  if (shortEdge >= 600 && (platform.isIosApp || platform.isTablet)) return false;
  if (shortEdge > 0) return shortEdge < 600;
  return platform.isPhone || !platform.isTablet;
}
