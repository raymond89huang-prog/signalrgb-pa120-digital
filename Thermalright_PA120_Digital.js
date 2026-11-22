// PA120 wire layout and HID frame format: thermalright-trcc-linux,
// doc/PROTOCOL_USBLED.md and src/trcc/core/led_protocol.py.
//
// Reliability pass (2026-11-23):
// - DeviceType "cooler" is rejected by SignalRGB (runtime assertion
//   "Unknown Device Type"); "aio" is the valid cooler-display type.
// - Frame rate capped at 5 fps instead of ~22 fps. The digits refresh at
//   1 Hz anyway; 22 fps only heated the display MCU and stressed the HID
//   endpoint, which is where the high-temperature dropouts came from.
// - HID writes are failure-tolerant: a failed write marks the device
//   offline and Render() re-runs the handshake with backoff instead of
//   leaving the plugin dead until SignalRGB restarts.
// - The telemetry socket is only rebuilt when it is actually closed;
//   stale samples no longer tear down a healthy connection, and the
//   dash threshold is 10 s so a loaded bridge does not blank the screen.
import tcp from "@SignalRGB/tcp";

const wireOrder = [
    1, 0, 15, 10, 11, 16, 14, 13, 12, 22, 17, 18, 23, 21, 20, 19,
    29, 24, 25, 30, 28, 27, 26, 4, 5, 81, 80, 36, 31, 32, 37, 35, 34, 33,
    43, 38, 39, 44, 42, 41, 40, 6, 9, 75, 76, 77, 79, 74, 73, 78, 68, 69,
    70, 72, 67, 66, 71, 82, 83, 7, 8, 61, 62, 63, 65, 60, 59, 64, 54, 55,
    56, 58, 53, 52, 57, 47, 48, 49, 51, 46, 45, 50, 2, 3,
];
const digits = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];
const zones = [
    { name: "CPU Temperature", labels: [0, 1, 4], starts: [10, 17, 24] },
    { name: "CPU Load", labels: [6], starts: [31, 38], hundred: [80, 81] },
    { name: "GPU Temperature", labels: [2, 3, 7], starts: [45, 52, 59] },
    { name: "GPU Load", labels: [9], starts: [66, 73], hundred: [82, 83] },
];
const magic = [0xda, 0xdb, 0xdc, 0xdd];

const FRAME_INTERVAL = 200;    // ms between HID frames (5 fps)
const TELEMETRY_STALE = 10000; // ms without samples before showing dashes
const RETRY_INIT = 5000;       // ms between re-handshake attempts
const RETRY_SOCKET = 4000;     // ms between telemetry reconnect attempts

let connected = false;
let telemetry;
let receivedAt = 0;
let socket;
let socketOpen = false;
let pending = "";
let nextConnect = 0;
let nextInit = 0;
let nextFrame = 0;
let lastFrame = "";
let loggedTransport = false;

export function Name() { return "Thermalright PA120 Digital"; }
export function Publisher() { return "Local"; }
export function VendorId() { return 0x0416; }
export function ProductId() { return 0x8001; }
export function DeviceType() { return "aio"; }
export function Size() { return [2, 2]; }
export function DefaultScale() { return 4; }
export function LedNames() { return zones.map(zone => zone.name); }
export function LedPositions() { return [[0, 0], [1, 0], [0, 1], [1, 1]]; }
export function ConflictingProcesses() { return ["TRCC.exe"]; }
export function Validate(endpoint) { return endpoint.usage_page === 0xff00 && endpoint.usage === 1; }

function header(command) {
    const bytes = new Array(20).fill(0);
    bytes.splice(0, 4, ...magic);
    bytes[12] = command;
    return bytes;
}

function send(bytes) {
    try {
        for (let offset = 0; offset < bytes.length; offset += 64) {
            const report = [0, ...bytes.slice(offset, offset + 64)];
            while (report.length < 65) report.push(0);
            device.write(report, report.length);
        }
        return true;
    } catch (error) {
        device.log("PA120 HID write failed: " + error + " — will re-handshake.");
        return false;
    }
}

export function Initialize() {
    connected = false;
    lastFrame = "";
    try {
        device.clearReadBuffer();
        device.pause(50);
        if (!send(header(1))) return;
        device.pause(200);
        let reply = device.read([], 65, 100);
        if (reply[0] === 0 && reply[1] === magic[0]) reply = reply.slice(1);
        if (reply.length > 0) {
            const model = reply[5];
            if (!magic.every((byte, index) => reply[index] === byte) || reply[12] !== 1 ||
                !(model >= 16 && model <= 31 && model !== 23)) {
                device.log("PA120 identification rejected. HID reply: " + JSON.stringify(reply.slice(0, 18)));
                return;
            }
            device.log("PA120 handshake confirmed, model " + model);
        } else {
            // The handshake reply is consumed once per power cycle; after a
            // USB re-enumeration the display may not answer again.
            device.log("PA120: no handshake reply; using the confirmed local PA120 layout.");
        }
        connected = true;
    } catch (error) {
        device.log("PA120 initialize failed: " + error);
    }
}

function placeValue(zone, value, color, frame) {
    for (const index of zone.labels) frame[index] = color;
    const known = Number.isFinite(value);
    const capped = known ? Math.trunc(Math.max(0, Math.min(zone.hundred ? 100 : 999, value))) : null;
    if (zone.hundred && capped === 100) {
        for (const index of zone.hundred) frame[index] = color;
    }
    const display = known ? (capped === 100 && zone.hundred ? "00" : String(capped)) : "--";
    const characters = display.padStart(zone.starts.length, " ");
    for (let index = 0; index < zone.starts.length; index++) {
        const character = characters[index];
        const segmentMask = character === " " ? 0 : character === "-" ? 64 : digits[Number(character)];
        for (let segment = 0; segment < 7; segment++) {
            if ((segmentMask & (1 << segment)) !== 0) frame[zone.starts[index] + segment] = color;
        }
    }
}

function buildFrame(values, colors) {
    const frame = Array(84).fill([0, 0, 0]);
    zones.forEach((zone, index) => placeValue(zone, values[index], colors[index], frame));
    const packet = header(2);
    packet[16] = 252;
    for (const index of wireOrder) {
        for (const value of frame[index]) packet.push(Math.floor(Math.min(255, Math.max(0, value)) * 0.4));
    }
    return packet;
}

function updateTelemetry(data) {
    if (!loggedTransport) {
        loggedTransport = true;
        const details = [Object.keys(data), Object.getOwnPropertyNames(data), Object.getOwnPropertyNames(Object.getPrototypeOf(data)),
            typeof data.length, typeof data.byteLength, typeof data.data, typeof data.bytes, typeof data.value, typeof data[0],
            typeof XMLHttpRequest, typeof fetch, Array.from(arguments).map(value => typeof value)];
        device.log("PA120 telemetry transport: " + JSON.stringify(details));
    }
    if (data && typeof data !== "string" && data.data) data = data.data;
    if (data && typeof data !== "string" && data.bytes) data = data.bytes;
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    if (typeof data === "string") pending += data;
    else if (data && typeof data.length === "number" && data.length < 4096) pending += String.fromCharCode.apply(null, Array.from(data));
    else return;
    const lines = pending.split("\n");
    pending = lines.pop();
    if (pending.length > 256) pending = "";
    for (const line of lines) {
        try {
            const sample = JSON.parse(line);
            if (Array.isArray(sample) && sample.length === 4 && sample.every(value => value === null || Number.isFinite(value))) {
                if (!telemetry) device.log("PA120: first live telemetry sample received.");
                telemetry = sample;
                receivedAt = Date.now();
            }
        } catch (error) { /* Ignore an invalid local sample. */ }
    }
}

function connectTelemetry() {
    if (socket) socket.close();
    socketOpen = false;
    try {
        socket = tcp.createSocket();
        pending = "";
        socket.on("connection", () => { socketOpen = true; device.log("PA120 telemetry connected."); });
        socket.on("message", updateTelemetry);
        socket.on("close", () => { socketOpen = false; pending = ""; });
        socket.on("error", error => { socketOpen = false; device.log("PA120 telemetry: " + error); });
        socket.connect("127.0.0.1", 17842);
    } catch (error) {
        device.log("PA120 telemetry connection failed: " + error);
    }
}

export function Render() {
    const now = Date.now();
    if (!connected) {
        // Recover from a dropped/stalled HID endpoint without an app restart.
        if (now >= nextInit) {
            nextInit = now + RETRY_INIT;
            Initialize();
        }
        return;
    }
    if (!socketOpen && now >= nextConnect) {
        nextConnect = now + RETRY_SOCKET;
        connectTelemetry();
    }
    if (now < nextFrame) return;
    nextFrame = now + FRAME_INTERVAL;
    const values = now - receivedAt < TELEMETRY_STALE ? telemetry : [null, null, null, null];
    const colors = LedPositions().map(([x, y]) => device.color(x, y));
    const frame = buildFrame(values, colors);
    const key = frame.join(",");
    if (key === lastFrame) return;
    if (!send(frame)) {
        connected = false;
        nextInit = now + RETRY_INIT;
        return;
    }
    lastFrame = key;
}

export function Shutdown() {
    if (socket) socket.close();
    socket = undefined;
    socketOpen = false;
    if (connected) send(buildFrame([null, null, null, null], Array(4).fill([0, 0, 0])));
    connected = false;
}
