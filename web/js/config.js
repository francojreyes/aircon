/** Fixed room list + protocol capabilities. Keep in sync with aircon.ino / proxy room ids. */

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

/** @type {const} */
export const ROOMS = [
  {
    id: "livingroom",
    name: "Living Room",
    accent: "#4fc3f7",
    protocol: "DAIKIN152",
  },
  {
    id: "bedroom",
    name: "Bedroom",
    accent: "#ba68c8",
    protocol: "DAIKIN152",
  },
  {
    id: "study",
    name: "Study",
    accent: "#81c784",
    protocol: "DAIKIN160",
  },
];

export function featuresForProtocol(protocol) {
  // Unknown protocols: assume the more limited remote (no quiet/night/comfort).
  return PROTOCOL_FEATURES[protocol] ?? PROTOCOL_FEATURES.DAIKIN160;
}

export function getAircons() {
  return ROOMS.map((room) => ({
    ...room,
    features: featuresForProtocol(room.protocol),
  }));
}
