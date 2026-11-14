/**
 * Classifier, calibration and framing thresholds. Distances are in calibrated shoulder widths
 * (sw), speeds in sw per second, angles in degrees. Image coordinates are aspect-corrected so
 * one unit is the frame height.
 */
export const CONFIG = {
  smoothing: { image: 0.6, worldZ: 0.45 },

  framing: {
    minVisibility: 0.6,
    minShoulderWidth: 0.16,
    maxShoulderWidth: 0.48,
    minNoseY: 0.06,
  },

  calibration: {
    holdMs: 2_000,
    maxWristJitter: 0.35,
    guardMaxHeadDist: 1.1,
  },

  punch: {
    startSpeed: 3.0,
    stopFraction: 0.35,
    maxDurationMs: 450,
    minTravel: 0.45,
    cooldownMs: 250,
    gassedCooldownMs: 450,
    returnHeadDist: 1.05,
    returnMaxY: 0.2,
    headBodySplit: 0.3,
  },

  straight: {
    minElbow: 150,
    minForward: 0.55,
    strongForward: 0.95,
    weights: { z: 1.0, scale: 1.2, travel: 0.5 },
  },

  hook: {
    minElbow: 65,
    maxElbow: 125,
    minY: -0.75,
    maxY: 0.75,
    minSweep: 0.45,
  },

  uppercut: {
    startBelowChin: 0.0,
    minRise: 0.45,
    maxElbow: 140,
    minUpSpeed: 3.0,
  },

  defense: {
    guardMaxY: -0.3,
    guardMaxHeadDist: 0.95,
    guardMaxSpeed: 2.5,
    /** Allowed slack around the calibrated guard position (sw). */
    guardSlack: 0.3,
    /** Extra slack once in guard, so it does not flicker. */
    guardHysteresis: 0.2,
    /** Slips are ignored while punching and for this long after, since punches move the head. */
    slipAfterPunchMs: 300,
    duckDrop: 0.55,
    slipShift: 0.5,
    /** Time constant for the neutral head position following the player around. */
    neutralDriftMs: 3_000,
  },

  /** A motion only counts as a punch if the arm opens up by this many degrees. */
  gate: { minElbowOpen: 15 },

  /** Per-player learned classifier, trained by the guided calibration. */
  model: {
    k: 3,
    repsPerMove: 3,
    moveTimeoutMs: 9_000,
    /** Duck and slip thresholds as a fraction of the player's own demonstrated depth. */
    defenseFraction: 0.5,
  },

  network: { poseHz: 20 },
} as const;
