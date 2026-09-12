export async function loadAircons() {
  const response = await fetch("rooms.json");
  if (!response.ok) {
    throw new Error(`Failed to load rooms.json (${response.status})`);
  }
  return response.json();
}
