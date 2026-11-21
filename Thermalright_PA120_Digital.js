// SPDX-License-Identifier: GPL-3.0-only
// PA120 wire layout and HID frame format: thermalright-trcc-linux,
// doc/PROTOCOL_USBLED.md and src/trcc/core/led_protocol.py.
import tcp from "@SignalRGB/tcp";

// Set to true only after verifying the attached display is a PA120 Digital.
const allowNoHandshake = false;

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
let connected = false;
let telemetry;
let receivedAt = 0;
let socket;
let pending = "";
let nextConnect = 0;
let nextFrame = 0;
let lastFrame = "";

export function Name() { return "Thermalright PA120 Digital"; }
export function Publisher() { return "PA120 Digital Community Plugin"; }
export function VendorId() { return 0x0416; }
export function ProductId() { return 0x8001; }
export function DeviceType() { return "cooler"; }
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
    for (let offset = 0; offset < bytes.length; offset += 64) {
        const report = [0, ...bytes.slice(offset, offset + 64)];
        while (report.length < 65) report.push(0);
        device.write(report, report.length);
    }
}

export function Initialize() {
    connected = false;
    lastFrame = "";
    device.clearReadBuffer();
    device.pause(50);
    send(header(1));
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
        if (!allowNoHandshake) {
            device.log("PA120: no model reply; streaming disabled. See the README for USB power-cycle and model verification.");
            return;
        }
        device.log("PA120: no model reply; using the explicitly enabled PA120 layout.");
    }
    connected = true;
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
    try {
        socket = tcp.createSocket();
        pending = "";
        socket.on("connection", () => device.log("PA120 telemetry connected."));
        socket.on("message", updateTelemetry);
        socket.on("close", () => { pending = ""; });
        socket.on("error", error => device.log("PA120 telemetry: " + error));
        socket.connect("127.0.0.1", 17842);
    } catch (error) {
        device.log("PA120 telemetry connection failed: " + error);
    }
}

export function Render() {
    if (!connected) return;
    const now = Date.now();
    if (now >= nextConnect && now - receivedAt > 5000) {
        nextConnect = now + 4000;
        connectTelemetry();
    }
    if (now < nextFrame) return;
    nextFrame = now + 45;
    const values = telemetry && now - receivedAt < 5000 ? telemetry : [null, null, null, null];
    const colors = LedPositions().map(([x, y]) => device.color(x, y));
    const frame = buildFrame(values, colors);
    const key = frame.join(",");
    if (key === lastFrame) return;
    lastFrame = key;
    send(frame);
}

export function Shutdown() {
    if (socket) socket.close();
    socket = undefined;
    if (connected) send(buildFrame([null, null, null, null], Array(4).fill([0, 0, 0])));
    connected = false;
}
