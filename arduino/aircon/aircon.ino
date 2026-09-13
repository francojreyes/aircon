#include <Arduino.h>
#include <EEPROM.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <IRac.h>
#include <ir_Daikin.h>

const uint16_t kIrLedPin = 4; // Physical Pin D2 on the NodeMCU
IRac ac(kIrLedPin);

// Room is selected at compile time (-DAIRCON_ROOM=Livingroom|Bedroom|Study).
// Default keeps IDE one-click uploads working without flags.
enum class Room : uint8_t { Livingroom, Bedroom, Study };
#ifndef AIRCON_ROOM
#define AIRCON_ROOM Livingroom
#endif
constexpr Room kRoom = Room::AIRCON_ROOM;

const char* nameForRoom(Room room) {
  switch (room) {
    case Room::Livingroom: return "livingroom";
    case Room::Bedroom:    return "bedroom";
    case Room::Study:      return "study";
  }
  return "study"; // unreachable — prefer limited-capability room
}

decode_type_t protocolForRoom(Room room) {
  switch (room) {
    case Room::Study:
      // study (ARC423A5)               -> DAIKIN160
      return decode_type_t::DAIKIN160;
    case Room::Livingroom:
    case Room::Bedroom:
      // livingroom/bedroom (ARC480A32) -> DAIKIN152
      return decode_type_t::DAIKIN152;
  }
  // Unreachable — default to the more limited protocol.
  return decode_type_t::DAIKIN160;
}

const char* localName = nameForRoom(kRoom);
decode_type_t ac_protocol = protocolForRoom(kRoom);

const char* ssid = "TP-Link";
const char* password = "francooo";

ESP8266WebServer server(80);

// Flash-backed copy of last successfully sent AC settings
const uint8_t kStateMagic = 0xAC;
const uint8_t kStateVersion = 2;
const int kEepromSize = 32;

// Comfort lives outside stdAc::state_t (IRac never sends it for DAIKIN152).
bool g_comfort = false;

struct PersistedState {
  uint8_t magic;
  uint8_t version;
  uint8_t power;
  uint8_t mode;
  uint8_t fanspeed;
  uint8_t quiet;
  uint8_t temp;
  uint8_t econo;
  uint8_t comfort;
};

void saveStateToEeprom(const stdAc::state_t& state) {
  PersistedState stored;
  stored.magic = kStateMagic;
  stored.version = kStateVersion;
  stored.power = state.power ? 1 : 0;
  stored.mode = static_cast<uint8_t>(state.mode);
  stored.fanspeed = static_cast<uint8_t>(state.fanspeed);
  stored.quiet = state.quiet ? 1 : 0;
  stored.temp = static_cast<uint8_t>(state.degrees);
  stored.econo = state.econo ? 1 : 0;
  stored.comfort = g_comfort ? 1 : 0;

  EEPROM.put(0, stored);
  EEPROM.commit();
  Serial.println("Saved AC state to EEPROM");
}

bool loadStateFromEeprom() {
  PersistedState stored;
  EEPROM.get(0, stored);

  if (stored.magic != kStateMagic || (stored.version != 1 && stored.version != kStateVersion)) {
    Serial.println("No persisted AC state found");
    return false;
  }

  if (stored.temp < 18 || stored.temp > 30) {
    Serial.println("Persisted temp out of range; ignoring");
    return false;
  }

  // v1 had no econo/comfort; those EEPROM bytes are garbage — default off.
  const bool fromV1 = stored.version == 1;
  if (fromV1) {
    stored.econo = 0;
    stored.comfort = 0;
  }

  ac.next.protocol = ac_protocol;
  ac.next.power = stored.power != 0;
  ac.next.mode = static_cast<stdAc::opmode_t>(stored.mode);
  ac.next.fanspeed = static_cast<stdAc::fanspeed_t>(stored.fanspeed);
  ac.next.quiet = stored.quiet != 0;
  ac.next.degrees = stored.temp;
  ac.next.econo = ac_protocol == decode_type_t::DAIKIN152 && stored.econo != 0;
  g_comfort = ac_protocol == decode_type_t::DAIKIN152 && stored.comfort != 0;
  if (g_comfort || ac.next.mode == stdAc::opmode_t::kDry) {
    ac.next.fanspeed = stdAc::fanspeed_t::kAuto;
  }
  ac.markAsSent(); // so /get matches without re-blasting IR

  if (fromV1) {
    saveStateToEeprom(ac.next); // rewrite as v2 for next boot
    Serial.println("Migrated AC state from EEPROM v1 -> v2");
  } else {
    Serial.println("Restored AC state from EEPROM");
  }
  return true;
}

void sendCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

String modeToApiString(stdAc::opmode_t mode) {
  switch (mode) {
    case stdAc::opmode_t::kCool: return "cool";
    case stdAc::opmode_t::kFan: return "fan";
    case stdAc::opmode_t::kHeat: return "heat";
    case stdAc::opmode_t::kDry: return "dry";
    case stdAc::opmode_t::kAuto: return "auto";
    default: return "off";
  }
}

String fanspeedToApiString(stdAc::fanspeed_t speed) {
  switch (speed) {
    case stdAc::fanspeed_t::kAuto: return "auto";
    case stdAc::fanspeed_t::kLow: return "1";
    case stdAc::fanspeed_t::kMedium: return "2";
    case stdAc::fanspeed_t::kMediumHigh: return "3";
    case stdAc::fanspeed_t::kHigh: return "4";
    case stdAc::fanspeed_t::kMax: return "5";
    case stdAc::fanspeed_t::kMin: return "night";
    default: return "auto";
  }
}

String protocolToApiString(decode_type_t protocol) {
  switch (protocol) {
    case decode_type_t::DAIKIN152: return "DAIKIN152";
    case decode_type_t::DAIKIN160: return "DAIKIN160";
    default: return "UNKNOWN";
  }
}

String stateToJson(const stdAc::state_t& state) {
  String json = "{";
  json += "\"power\":";
  json += state.power ? "true" : "false";
  json += ",\"temp\":";
  json += String((int)state.degrees);
  json += ",\"mode\":\"";
  json += modeToApiString(state.mode);
  json += "\",\"fan_speed\":\"";
  json += fanspeedToApiString(state.fanspeed);
  json += "\",\"quiet\":";
  json += state.quiet ? "true" : "false";
  json += ",\"comfort\":";
  json += g_comfort ? "true" : "false";
  json += ",\"economy\":";
  json += state.econo ? "true" : "false";
  json += ",\"protocol\":\"";
  json += protocolToApiString(ac_protocol);
  json += "\",\"room\":\"";
  json += localName;
  json += "\"}";
  return json;
}

bool argOn(const String& value) {
  return value == "on" || value == "1" || value == "true";
}

void applyQueryParams() {
  ac.next.protocol = ac_protocol;

  if (server.hasArg("power")) {
    ac.next.power = argOn(server.arg("power"));
  }

  if (server.hasArg("temp")) {
    int t = server.arg("temp").toInt();
    if (t >= 18 && t <= 30) {
      ac.next.degrees = t;
    }
  }

  if (server.hasArg("mode")) {
    String m = server.arg("mode");
    if (m == "cool") ac.next.mode = stdAc::opmode_t::kCool;
    else if (m == "fan") ac.next.mode = stdAc::opmode_t::kFan;
    else if (m == "dry") ac.next.mode = stdAc::opmode_t::kDry;
  }

  if (server.hasArg("quiet")) {
    String q = server.arg("quiet");
    if (ac_protocol == decode_type_t::DAIKIN160) {
      ac.next.quiet = false;
      if (argOn(q)) {
        ac.next.fanspeed = stdAc::fanspeed_t::kLow;
      }
    } else {
      ac.next.quiet = argOn(q);
    }
  }

  if (server.hasArg("fan_speed")) {
    String f = server.arg("fan_speed");

    if (f == "auto")          ac.next.fanspeed = stdAc::fanspeed_t::kAuto;
    else if (f == "1")        ac.next.fanspeed = stdAc::fanspeed_t::kLow;
    else if (f == "2")        ac.next.fanspeed = stdAc::fanspeed_t::kMedium;
    else if (f == "3")        ac.next.fanspeed = stdAc::fanspeed_t::kMediumHigh;
    else if (f == "4")        ac.next.fanspeed = stdAc::fanspeed_t::kHigh;
    else if (f == "5")        ac.next.fanspeed = stdAc::fanspeed_t::kMax;
    else if (f == "night") {
      if (ac_protocol == decode_type_t::DAIKIN160) {
        ac.next.fanspeed = stdAc::fanspeed_t::kLow;
      } else {
        ac.next.fanspeed = stdAc::fanspeed_t::kMin;
      }
    }
  }

  if (ac_protocol == decode_type_t::DAIKIN152) {
    if (server.hasArg("economy")) {
      ac.next.econo = argOn(server.arg("economy"));
    }
    if (server.hasArg("comfort")) {
      g_comfort = argOn(server.arg("comfort"));
    }
  } else {
    ac.next.econo = false;
    g_comfort = false;
  }

  // Quiet is cool-only on these remotes; dry/fan clear it.
  if (ac.next.mode == stdAc::opmode_t::kDry ||
      ac.next.mode == stdAc::opmode_t::kFan) {
    ac.next.quiet = false;
  }

  // Comfort & economy only apply while cooling (cool/dry), not fan-only.
  if (ac.next.mode == stdAc::opmode_t::kFan) {
    ac.next.econo = false;
    g_comfort = false;
  }

  if (g_comfort || ac.next.mode == stdAc::opmode_t::kDry) {
    ac.next.fanspeed = stdAc::fanspeed_t::kAuto;
  }
}

void sendIr() {
  if (ac_protocol == decode_type_t::DAIKIN152) {
    // IRac does not send Comfort for DAIKIN152; use the native class.
    IRDaikin152 unit(kIrLedPin);
    unit.begin();
    unit.setPower(ac.next.power);
    unit.setMode(unit.convertMode(ac.next.mode));
    unit.setTemp(static_cast<uint8_t>(ac.next.degrees));
    unit.setFan(unit.convertFan(ac.next.fanspeed));
    unit.setQuiet(ac.next.quiet);
    unit.setEcono(ac.next.econo);
    // setComfort forces fan auto + swingv off when enabling
    unit.setComfort(g_comfort);
    unit.send();
    ac.markAsSent();
  } else {
    ac.next.econo = false;
    g_comfort = false;
    ac.sendAc();
  }
}

void handleACGet() {
  sendCorsHeaders();
  ac.next.protocol = ac_protocol;
  server.send(200, "application/json", stateToJson(ac.getStatePrev()));
}

void handleACSet() {
  sendCorsHeaders();
  applyQueryParams();
  sendIr();
  const auto sent = ac.getStatePrev();
  saveStateToEeprom(sent);
  server.send(200, "application/json", stateToJson(sent));
}

void handleOptions() {
  sendCorsHeaders();
  server.send(204);
}

const char* wifiStatusToString(wl_status_t status) {
  switch (status) {
    case WL_IDLE_STATUS: return "IDLE";
    case WL_NO_SSID_AVAIL: return "NO_SSID_AVAIL (wrong name or 5GHz-only)";
    case WL_SCAN_COMPLETED: return "SCAN_COMPLETED";
    case WL_CONNECTED: return "CONNECTED";
    case WL_CONNECT_FAILED: return "CONNECT_FAILED (wrong password?)";
    case WL_CONNECTION_LOST: return "CONNECTION_LOST";
    case WL_DISCONNECTED: return "DISCONNECTED";
    default: return "UNKNOWN";
  }
}

void scanNetworks() {
  Serial.println("Scanning 2.4 GHz networks...");
  int n = WiFi.scanNetworks();
  if (n <= 0) {
    Serial.println("No networks found.");
    return;
  }
  Serial.print(n);
  Serial.println(" network(s):");
  bool foundTarget = false;
  for (int i = 0; i < n; i++) {
    Serial.print("  ");
    Serial.print(WiFi.SSID(i));
    Serial.print("  RSSI=");
    Serial.print(WiFi.RSSI(i));
    Serial.print("  enc=");
    Serial.println(WiFi.encryptionType(i) == ENC_TYPE_NONE ? "open" : "secured");
    if (WiFi.SSID(i) == ssid) foundTarget = true;
  }
  if (foundTarget) {
    Serial.print("Found configured SSID: ");
    Serial.println(ssid);
  } else {
    Serial.print("Configured SSID NOT in scan: \"");
    Serial.print(ssid);
    Serial.println("\" — copy the exact name from the list above into ssid.");
  }
  WiFi.scanDelete();
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("Booting aircon controller...");

  EEPROM.begin(kEepromSize);
  loadStateFromEeprom();

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
  scanNetworks();

  WiFi.begin(ssid, password);
  Serial.print("Connecting to SSID: ");
  Serial.println(ssid);

  uint8_t attempts = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    attempts++;
    if (attempts % 20 == 0) {
      Serial.println();
      Serial.print("Still waiting... status=");
      Serial.println(wifiStatusToString(WiFi.status()));
    }
    if (attempts >= 60) { // ~30 seconds
      Serial.println();
      Serial.println("WiFi failed. Check SSID/password and that the network is 2.4 GHz.");
      Serial.print("Final status=");
      Serial.println(wifiStatusToString(WiFi.status()));
      return; // Don't start the server without WiFi
    }
  }

  Serial.println();
  Serial.print("WiFi OK. IP: ");
  Serial.println(WiFi.localIP());
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  Serial.println("WiFi sleep disabled (WIFI_NONE_SLEEP)");

  if (MDNS.begin(localName)) {
    Serial.println("mDNS responder started");
  }

  server.on("/get", HTTP_GET, handleACGet);
  server.on("/get", HTTP_OPTIONS, handleOptions);
  server.on("/set", HTTP_GET, handleACSet);
  server.on("/set", HTTP_OPTIONS, handleOptions);
  server.begin();
  Serial.println("HTTP server ready");
}

void loop() {
  server.handleClient();
  MDNS.update();
}
