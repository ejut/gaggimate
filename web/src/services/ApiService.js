import { createContext } from 'preact';
import { parseWarningStates } from '../utils/warnings.js';
import { signal } from '@preact/signals';
import uuidv4 from '../utils/uuid.js';
import { isApp } from '../app/platform.js';
import { machineSocketUrl } from '../app/machines.js';
import { latencyProbeEnabled, latencyStats, STATUS_COMMANDS } from '../utils/latencyProbe.js';
import {
  extendGrace,
  graceAfterOtaProgress,
  inGrace,
  isStale,
  OTA_CHECK_GRACE_MS,
  OTA_GRACE_MS,
  reconnectDelay,
  STALE_AFTER_MS,
  STALE_AFTER_WAKE_MS,
} from '../utils/connectionHealth.js';

// How often the watchdog checks whether the firmware has gone silent.
const WATCHDOG_INTERVAL_MS = 2000;

function randomId() {
  return Math.random()
    .toString(36)
    .replace(/[^a-z]+/g, '')
    .substr(2, 10);
}

export default class ApiService {
  socket = null;
  listeners = {};
  reconnectAttempts = 0;
  maxReconnectDelay = 30000; // Maximum delay of 30 seconds
  baseReconnectDelay = 1000; // Start with 1 second delay
  reconnectTimeout = null;
  isConnecting = false;
  _probeCommand = null; // latency probe: the last status-changing command awaiting its status frame
  _rttTimer = null;
  lastMessageAt = 0; // performance.now() of the last frame from the firmware; 0 until the first one
  _watchdogTimer = null;
  // performance.now() until which silence from the firmware is expected, because a firmware update or an update
  // check blocks its main loop (and with it the status frames). The watchdog stands down until then.
  _silenceGraceUntil = 0;
  _listeningForWake = false;

  // socketUrl/state let extra instances watch other machines without touching the dashboard's state.
  constructor({ socketUrl = null, state = machine } = {}) {
    this.socketUrl = socketUrl;
    this.state = state;
    this.closed = false;
  }

  // Disconnects without scheduling reconnects until reopen().
  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimeout);
    this._stopRttProbe();
    this._stopWatchdog();
    this._removeWakeListeners();
    this.socket?.close();
  }

  reopen() {
    this.closed = false;
    this.reconnectAttempts = 0;
    this.connect();
  }

  async connect() {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      if (this.socket) {
        this.socket.close();
      }

      const wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
      const socketUrl =
        this.socketUrl ?? (isApp ? machineSocketUrl() : `${wsProtocol}${window.location.host}/ws`);
      // In the app there's nothing to connect to until a machine has been set up.
      if (!socketUrl) return;
      this.socket = new WebSocket(socketUrl);

      this.socket.addEventListener('message', this._onMessage.bind(this));
      this.socket.addEventListener('close', this._onClose.bind(this));
      this.socket.addEventListener('error', this._onError.bind(this));
      this.socket.addEventListener('open', this._onOpen.bind(this));
      this._addWakeListeners();
    } catch (error) {
      console.error('WebSocket connection error:', error);
      this._scheduleReconnect();
    } finally {
      this.isConnecting = false;
    }
  }

  _onOpen(event) {
    if (event?.target && event.target !== this.socket) return; // a socket we already replaced
    console.log('WebSocket connected successfully');
    this.lastMessageAt = performance.now();
    this._startWatchdog();
    if (latencyProbeEnabled) this._startRttProbe();
    this.reconnectAttempts = 0;
    this.state.value = {
      ...this.state.value,
      connected: true,
    };
  }

  _onClose(event) {
    if (event?.target && event.target !== this.socket) return; // a socket we already replaced
    console.log('WebSocket connection closed');
    this._stopRttProbe();
    this._stopWatchdog();
    this._markDisconnected();
    this._scheduleReconnect();
  }

  _markDisconnected() {
    this._silenceGraceUntil = 0; // a new connection starts fresh (after an update the device has restarted)
    this.state.value = {
      ...this.state.value,
      connected: false,
      // scan:complete can't arrive on a dead socket, so don't leave the spinner latched.
      scale: { ...machine.value.scale, scanning: false },
    };
  }

  _onError(error) {
    if (error?.target && error.target !== this.socket) return; // a socket we already replaced
    console.error('WebSocket error:', error);
    if (this.socket) {
      this.socket.close();
    }
  }

  _scheduleReconnect() {
    if (this.closed) return;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    const delay = reconnectDelay(this.reconnectAttempts, {
      base: this.baseReconnectDelay,
      max: this.maxReconnectDelay,
    });

    console.log(`Scheduling reconnect attempt ${this.reconnectAttempts + 1} in ${delay}ms`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  _onMessage(event) {
    if (event?.target && event.target !== this.socket) return; // a socket we already replaced
    this.lastMessageAt = performance.now();
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return; // Discard malformed messages to avoid crashing the WS handler.
    }
    if (message.tp === 'evt:ota-progress') {
      this._silenceGraceUntil = graceAfterOtaProgress(
        performance.now(),
        this._silenceGraceUntil,
        message.phase,
      );
    }
    const listeners = Object.values(this.listeners[message.tp] || {});
    if (message.tp === 'evt:status') {
      if (latencyProbeEnabled) this._probeStatus(message);
      this._onStatus(message);
    } else if (message.tp === 'evt:hardware-scale') {
      this._onHardwareScale(message);
    } else if (message.tp.startsWith('evt:scale:')) {
      this._onScaleEvent(message);
    }
    for (const listener of listeners) {
      listener(message);
    }
  }

  send(event) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      if (event.tp === 'req:ota-start') {
        this._silenceGraceUntil = extendGrace(
          performance.now(),
          this._silenceGraceUntil,
          OTA_GRACE_MS,
        );
      } else if (event.tp === 'req:ota-settings' && event.update) {
        // Changing the release channel makes the firmware run a blocking update check right away.
        this._silenceGraceUntil = extendGrace(
          performance.now(),
          this._silenceGraceUntil,
          OTA_CHECK_GRACE_MS,
        );
      }
      if (latencyProbeEnabled && STATUS_COMMANDS.has(event.tp)) {
        this._probeCommand = { tp: event.tp, at: performance.now() };
      }
      this.socket.send(JSON.stringify(event));
    } else {
      throw new Error('WebSocket is not connected');
    }
  }

  async request(data = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    const returnType = `res:${data.tp.substring(4)}`;
    const rid = uuidv4();
    const message = { ...data, rid };
    return new Promise((resolve, reject) => {
      let timeoutId;

      // Create a listener for the response with matching rid
      const listenerId = this.on(returnType, response => {
        if (response.rid === rid) {
          // Clean up the listener and cancel the timeout to free the closure.
          clearTimeout(timeoutId);
          this.off(returnType, listenerId);
          resolve(response);
        }
      });

      // Send the request
      this.send(message);

      // Timeout: reject if no matching response arrives within 30 seconds
      timeoutId = setTimeout(() => {
        this.off(returnType, listenerId);
        reject(new Error(`Request ${data.tp} timed out`));
      }, 30000); // 30 second timeout
    });
  }

  // A connection can die without the browser noticing (WiFi dropped, machine rebooted, phone changed network):
  // the socket stays "open" until a TCP timeout. The firmware sends status every ~500 ms, so a long silence
  // means the connection is gone; replace the socket instead of waiting for the browser to report it.
  _startWatchdog() {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(() => {
      const now = performance.now();
      if (
        this.socket?.readyState === WebSocket.OPEN &&
        !inGrace(now, this._silenceGraceUntil) &&
        isStale(now, this.lastMessageAt, STALE_AFTER_MS)
      ) {
        console.warn('WebSocket went silent, reconnecting');
        this._reconnectNow();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  _stopWatchdog() {
    clearInterval(this._watchdogTimer);
    this._watchdogTimer = null;
  }

  // Drops the current socket and connects again immediately. Events from the old socket are ignored from here
  // on (see the event.target checks), because a dead socket may only report its close much later.
  _reconnectNow() {
    clearTimeout(this.reconnectTimeout);
    this._stopRttProbe();
    this._stopWatchdog();
    const stale = this.socket;
    this.socket = null;
    try {
      stale?.close();
    } catch {
      // Already closed.
    }
    this._markDisconnected();
    this.reconnectAttempts = 0;
    this.connect();
  }

  // The tab became visible again or the network came back: do not wait for the backoff timer or the watchdog.
  _onWake = () => {
    if (this.closed || document.visibilityState === 'hidden') return;
    const readyState = this.socket?.readyState;
    if (readyState === WebSocket.CONNECTING) return;
    if (readyState === WebSocket.OPEN) {
      const now = performance.now();
      if (
        !inGrace(now, this._silenceGraceUntil) &&
        isStale(now, this.lastMessageAt, STALE_AFTER_WAKE_MS)
      ) {
        this._reconnectNow();
      }
      return;
    }
    clearTimeout(this.reconnectTimeout);
    this.reconnectAttempts = 0;
    this.connect();
  };

  _addWakeListeners() {
    if (this._listeningForWake || typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', this._onWake);
    window.addEventListener('online', this._onWake);
    this._listeningForWake = true;
  }

  _removeWakeListeners() {
    if (!this._listeningForWake) return;
    document.removeEventListener('visibilitychange', this._onWake);
    window.removeEventListener('online', this._onWake);
    this._listeningForWake = false;
  }

  // Shows the expected result of a command right away. The firmware publishes the real state right after
  // handling the command, so the next slow-state frame confirms this or corrects it.
  applyOptimistic(statusPatch) {
    this.state.value = {
      ...this.state.value,
      status: { ...this.state.value.status, ...statusPatch },
    };
  }

  // Latency probe: slow-state frames (they carry `m`) are the ones that show a command's result.
  _probeStatus(message) {
    if (!this._probeCommand || !Object.prototype.hasOwnProperty.call(message, 'm')) return;
    const { tp, at } = this._probeCommand;
    this._probeCommand = null;
    const elapsed = performance.now() - at;
    // A command that changed nothing is only followed by the 10 s resend; that is not a latency.
    if (elapsed > 3000) return;
    latencyStats.value = { ...latencyStats.value, command: elapsed, commandType: tp };
  }

  _startRttProbe() {
    this._stopRttProbe();
    const ping = async () => {
      const started = performance.now();
      try {
        await this.request({ tp: 'req:ping' });
        latencyStats.value = { ...latencyStats.value, rtt: performance.now() - started };
      } catch {
        // Socket closed or firmware without req:ping: leave the last value.
      }
    };
    ping();
    this._rttTimer = setInterval(ping, 2000);
  }

  _stopRttProbe() {
    clearInterval(this._rttTimer);
    this._rttTimer = null;
  }

  on(type, listener) {
    const id = randomId();
    if (!this.listeners[type]) {
      this.listeners[type] = {};
    }
    this.listeners[type][id] = listener;
    return id;
  }

  off(type, id) {
    delete this.listeners[type][id];
  }

  // evt:status frames are partial: fast telemetry every tick, slow state only when it changes
  // (plus a full snapshot on connect and every 10 s). Merge onto the last known status.
  _onStatus(message) {
    const has = key => Object.prototype.hasOwnProperty.call(message, key);
    const status = { ...this.state.value.status };
    const map = (key, name, convert = v => v) => {
      if (has(key)) status[name] = convert(message[key]);
    };
    map('ct', 'currentTemperature');
    map('tt', 'targetTemperature');
    map('cst', 'currentSteamTemperature');
    map('tst', 'targetSteamTemperature');
    map('sa', 'steamActive');
    map('sca', 'steamControlsAvailable');
    map('pr', 'currentPressure');
    map('pt', 'targetPressure');
    map('tw', 'targetWeight', v => v || 0);
    map('fl', 'currentFlow');
    map('awl', 'albaWaterLevelAvailable');
    map('htl', 'hasTankLevel');
    map('tlo', 'tankLevelOK', v => v ?? null);
    map('hsl', 'hasSteamLevel');
    map('sbl', 'steamBoilerLow', v => v ?? null);
    map('tf', 'targetFlow', v => v || 0);
    map('m', 'mode');
    map('p', 'selectedProfile');
    map('puid', 'selectedProfileId');
    map('bt', 'brewTarget', v => !!v);
    map('btd', 'brewTargetDuration', v => v || 0);
    map('bta', 'volumetricAvailable', v => v || false);
    map('gtd', 'grindTargetDuration', v => v || 0);
    map('gtv', 'grindTargetVolume', v => v || 0);
    map('gt', 'grindTarget', v => v || 0);
    map('gact', 'grindActive', v => v || false);
    map('cw', 'currentWeight', v => v || 0);
    map('smartDose', 'smartDose');
    map('bc', 'bluetoothConnected', v => v || false);
    map('scaleSource', 'activeScaleSource', v => v || 'inactive');
    map('sbat', 'scaleBattery', v => v ?? null);
    map('process', 'process', v => v || null);
    map('rssi', 'rssi', v => v || 0);
    map('lnk', 'controllerLink', v => v || 'none');
    map('lat', 'lat', v => v || 0);
    map('rtx', 'rtx', v => v || 0);
    map('tof', 'tofDistance', v => v || 0);
    map('pw', 'currentPumpPower', v => v ?? 0);
    map('hp', 'currentBoilerPower', v => v ?? 0);
    map('pkr', 'currentPuckResistance', v => v ?? 0);
    map('pf', 'currentPuckFlow', v => v ?? 0);
    map('cv', 'currentCoffeeVolume', v => v ?? 0);
    map('up', 'update', v => !!v);
    map('warn', 'warnings', parseWarningStates);
    map('sys', 'system', v => ({ state: v?.s ?? 'ready', message: v?.m ?? '', code: v?.c ?? 0 }));
    status.activeTargetWeight = (status.process?.a && status.targetWeight) || 0;
    status.timestamp = new Date();

    const capabilities = { ...this.state.value.capabilities };
    if (has('cd')) capabilities.dimming = message.cd;
    if (has('cp')) capabilities.pressure = message.cp;
    if (has('led')) capabilities.ledControl = message.led;
    if (has('tofc')) capabilities.tof = message.tofc;
    if (has('gp')) capabilities.gearpumpAddon = !!message.gp;
    if (has('db')) capabilities.dualBoiler = message.db;
    if (has('hs')) capabilities.hardwareScale = !!message.hs;
    if (has('sd')) capabilities.sdCard = !!message.sd;

    // Only telemetry frames extend the chart history; state-only frames would duplicate points.
    let history = this.state.value.history;
    if (has('ct')) {
      const historyEntry = { ...status };
      delete historyEntry.process;
      delete historyEntry.warnings;
      history = [...history, historyEntry].slice(-600);
    }

    this.state.value = { ...this.state.value, connected: true, status, capabilities, history };
  }

  _onScaleEvent(message) {
    const now = Date.now();
    switch (message.tp) {
      case 'evt:scale:scan:complete':
        updateScaleState({ scanning: false });
        break;
      case 'evt:scale:connect:error':
        updateScaleState({
          connectError: { address: message.address, reason: message.reason, at: now },
        });
        break;
      case 'evt:scale:connect:success':
        updateScaleState({ connectError: null, disconnected: null });
        break;
      case 'evt:scale:disconnect':
        updateScaleState({
          disconnected: { address: message.address, name: message.name, at: now },
        });
        break;
    }
  }

  _onHardwareScale(message) {
    this.state.value = {
      ...this.state.value,
      status: {
        ...this.state.value.status,
        hardwareScaleCell1Weight: message.c1 ?? 0,
        hardwareScaleCell2Weight: message.c2 ?? 0,
        hardwareScaleCell1Valid: !!message.c1v,
        hardwareScaleCell2Valid: !!message.c2v,
      },
    };
  }
}

export const ApiServiceContext = createContext(null);

// Fresh per-machine state; `machine` is the one the UI renders.
export const createMachineState = () =>
  signal({
    connected: false,
    status: {
      currentTemperature: 0,
      targetTemperature: 0,
      currentSteamTemperature: 0,
      targetSteamTemperature: 0,
      currentFlow: 0,
      targetFlow: 0,
      mode: 0,
      selectedProfile: '',
      selectedProfileId: null,
      brewTargetDuration: 0,
      brewTargetVolume: 0,
      grindTargetDuration: 0,
      grindTargetVolume: 0,
      grindTarget: 0,
      grindActive: false,
      process: null,
      update: false,
      warnings: [],
      system: null,
    },
    capabilities: {
      pressure: false,
      dimming: false,
      dualBoiler: false,
      hardwareScale: false,
      sdCard: false,
    },
    // BLE scale lifecycle from evt:scale:* (GM-257).
    scale: {
      scanning: false,
      connectError: null,
      disconnected: null,
    },
    history: [],
  });

export const machine = createMachineState();

export const updateScaleState = patch => {
  machine.value = { ...machine.value, scale: { ...machine.value.scale, ...patch } };
};

let settingsCache = null;
let settingsData = null;

export const prefetchSettings = () => {
  if (!settingsCache) {
    settingsCache = fetch('/api/settings')
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        settingsData = data;
        return data;
      })
      .catch(err => {
        settingsCache = null;
        throw err;
      });
  }
  return settingsCache;
};

export const getCachedSettings = () => settingsData;

export const updateSettingsCache = data => {
  settingsData = data;
  settingsCache = Promise.resolve(data);
};

export const invalidateSettingsCache = () => {
  settingsData = null;
  settingsCache = null;
};
