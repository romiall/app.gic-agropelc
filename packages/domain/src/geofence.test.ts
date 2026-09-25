import { describe, expect, it } from 'vitest';
import { buildGeofence } from './geofence.js';
import { DomainError } from './errors.js';

describe('buildGeofence', () => {
  it('null quand ni latitude ni longitude ne sont fournies', () => {
    expect(buildGeofence({})).toBeNull();
    expect(buildGeofence({ lat: null, lng: null })).toBeNull();
  });

  it('applique le rayon par défaut (500 m) quand il est omis', () => {
    expect(buildGeofence({ lat: 4.05, lng: 9.7 })).toEqual({ lat: 4.05, lng: 9.7, radiusM: 500 });
  });

  it('conserve un rayon explicite dans les bornes', () => {
    expect(buildGeofence({ lat: 4.05, lng: 9.7, radiusM: 1000 })).toEqual({
      lat: 4.05,
      lng: 9.7,
      radiusM: 1000,
    });
  });

  it('rejette latitude sans longitude (et inversement)', () => {
    expect(() => buildGeofence({ lat: 4.05 })).toThrow(DomainError);
    expect(() => buildGeofence({ lng: 9.7 })).toThrow(DomainError);
  });

  it('rejette une latitude ou longitude hors limites', () => {
    expect(() => buildGeofence({ lat: 91, lng: 9.7 })).toThrow(DomainError);
    expect(() => buildGeofence({ lat: 4.05, lng: 181 })).toThrow(DomainError);
  });

  it('rejette un rayon hors bornes (50 à 5000 m)', () => {
    expect(() => buildGeofence({ lat: 4.05, lng: 9.7, radiusM: 49 })).toThrow(DomainError);
    expect(() => buildGeofence({ lat: 4.05, lng: 9.7, radiusM: 5001 })).toThrow(DomainError);
  });
});
