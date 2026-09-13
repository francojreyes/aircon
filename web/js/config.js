/** Remote/protocol capabilities — keep in sync with aircon.ino protocolForRoom. */
const PROTOCOL_FEATURES = {
  DAIKIN152: {
    quiet: true,
    night: true,
    comfortEconomy: true,
  },
  DAIKIN160: {
    quiet: false,
    night: false,
    comfortEconomy: false,
  },
};

export function featuresForProtocol(protocol) {
  // Unknown protocols: assume the more limited remote (no quiet/night/comfort).
  return PROTOCOL_FEATURES[protocol] ?? PROTOCOL_FEATURES.DAIKIN160;
}

export async function loadAircons() {
  const response = await fetch("rooms.json");
  if (!response.ok) {
    throw new Error(`Failed to load rooms.json (${response.status})`);
  }
  const rooms = await response.json();
  return rooms.map((room) => ({
    ...room,
    features: featuresForProtocol(room.protocol),
  }));
}
