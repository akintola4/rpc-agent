import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSETS_DIR, bezelLayoutFor } from '../src/bezel.js';
import {
  DEFAULT_DEVICES,
  DEVICE_ALIASES,
  DEVICES,
  DEVICES_BY_ID,
  emulationFor,
  resolveDevice,
  resolveDevices,
  UnknownDeviceError,
} from '../src/devices.js';

describe('device catalog', () => {
  it('has unique ids and sane dimensions', () => {
    const ids = DEVICES.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEVICES.length).toBe(49); // same catalog as RPC
    for (const d of DEVICES) {
      expect(d.width).toBeGreaterThan(0);
      expect(d.height).toBeGreaterThan(0);
      expect(d.dpr).toBeGreaterThanOrEqual(1);
    }
  });

  it('aliases and defaults point at real devices', () => {
    for (const id of [...Object.values(DEVICE_ALIASES), ...DEFAULT_DEVICES]) {
      expect(DEVICES_BY_ID[id], id).toBeDefined();
    }
  });

  it('every bezel artwork file exists', () => {
    for (const d of DEVICES) {
      const { src } = bezelLayoutFor(d);
      expect(existsSync(resolve(ASSETS_DIR, src)), `${d.id} -> ${src}`).toBe(true);
    }
  });

  it('resolves ids case-insensitively and via aliases', () => {
    expect(resolveDevice('iPhone-15').id).toBe('iphone-15');
    expect(resolveDevice('ipad').id).toBe('ipad-air-11');
    expect(resolveDevice('desktop').id).toBe('desktop-1440');
  });

  it('dedupes resolved lists, keeping order', () => {
    const ids = resolveDevices(['iphone', 'iphone-15-pro', 'desktop-1440']).map(d => d.id);
    expect(ids).toEqual(['iphone-15-pro', 'desktop-1440']);
  });

  it('throws with suggestions for unknown ids', () => {
    try {
      resolveDevice('iphone-15-promax');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownDeviceError);
      expect((err as UnknownDeviceError).suggestions).toContain('iphone-15-pro-max');
    }
  });

  it('emulates mobile UA + touch for phones and tablets only', () => {
    expect(emulationFor(resolveDevice('iphone-15')).userAgent).toMatch(/iPhone/);
    expect(emulationFor(resolveDevice('pixel-8')).userAgent).toMatch(/Android.*Mobile/);
    expect(emulationFor(resolveDevice('ipad-pro-11')).userAgent).toMatch(/iPad/);
    const desktop = emulationFor(resolveDevice('desktop-1440'));
    expect(desktop).toEqual({ userAgent: undefined, isMobile: false, hasTouch: false });
  });
});

describe('bezel layout', () => {
  it('screen rect always equals the device viewport', () => {
    for (const d of DEVICES) {
      const { screen } = bezelLayoutFor(d);
      expect([screen.width, screen.height], d.id).toEqual([d.width, d.height]);
    }
  });

  it('screen rect sits inside the outer box', () => {
    for (const d of DEVICES) {
      const l = bezelLayoutFor(d);
      expect(l.screen.x).toBeGreaterThanOrEqual(0);
      expect(l.screen.y).toBeGreaterThanOrEqual(0);
      expect(l.screen.x + l.screen.width, d.id).toBeLessThanOrEqual(l.outerWidth);
      expect(l.screen.y + l.screen.height, d.id).toBeLessThanOrEqual(l.outerHeight);
    }
  });

  it('uses per-device overrides verbatim', () => {
    expect(bezelLayoutFor(resolveDevice('iphone-17-pro'))).toEqual({
      src: 'bezels/iphone-17-pro.svg',
      outerWidth: 440,
      outerHeight: 908,
      screen: { x: 19, y: 19, width: 402, height: 874, radius: 56 },
    });
  });

  it('pads kind defaults (iPhone 15 Pro, phone-island ratios)', () => {
    const l = bezelLayoutFor(resolveDevice('iphone-15-pro'));
    expect(l.src).toBe('bezels/phone-island.svg');
    expect(l.screen).toEqual({ x: 22, y: 31, width: 393, height: 852, radius: 49 });
    expect([l.outerWidth, l.outerHeight]).toEqual([437, 920]);
  });
});
