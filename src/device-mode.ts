interface DevicePlatform {
  isDesktopApp: boolean;
  isMobileApp: boolean;
  isPhone: boolean;
  isTablet: boolean;
}

interface DeviceScreen {
  width: number;
  height: number;
  userAgent: string;
  maxTouchPoints: number;
}

/** Choose once from device facts, never from a view's resizable viewport.
 * Browsers do not expose whether a stylus is paired. Mobile tablets are the
 * handwriting-first exception; desktops and unknown devices start reading.
 */
export function defaultReadingMode(platform: DevicePlatform, device: DeviceScreen): boolean {
  if (platform.isDesktopApp || !platform.isMobileApp) return true;
  const ipad = /iPad/i.test(device.userAgent)
    || (/Macintosh/i.test(device.userAgent) && device.maxTouchPoints > 1);
  const shortEdge = Math.min(device.width, device.height);
  // Obsidian's isPhone/isTablet reflect available UI space. A narrow iPad
  // multiwindow can report phone UI, but its physical screen is still a tablet.
  if (ipad) return false;
  if (shortEdge > 0) return shortEdge < 600;
  return platform.isPhone || !platform.isTablet;
}
