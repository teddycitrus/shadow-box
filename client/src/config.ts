/**
 * Classifier, calibration and framing thresholds. Distances are in calibrated shoulder widths
 * (sw), speeds in sw per second, angles in degrees. Image coordinates are aspect-corrected so
 * one unit is the frame height.
 */
export const CONFIG = {
  /** Exponential smoothing per frame at 30 fps (scaled for other frame rates). */
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

  /**
   * Motion segmentation. Each hand's motion is measured from where it rests: a motion starts once
   * the hand is startDist from rest, peaks at its furthest point, and ends when it comes back to
   * reverseFraction of that distance or stalls (speed under stopFraction of its top speed).
   */
  punch: {
    /** Below this hand speed the hand counts as resting and its rest position follows it. */
    restSpeed: 1.5,
    anchorFollowMs: 120,
    startDist: 0.3,
    startSpeed: 3.0,
    stopFraction: 0.25,
    reverseFraction: 0.8,
    maxDurationMs: 550,
    /** Fire as soon as the hand stops getting further from rest (peakConfirmFrames frames past the
     *  furthest point, and back under peakConfirmDrop of that distance) instead of waiting for the
     *  motion to end. A motion that does not read as a punch then is decided again at its end. */
    earlyFire: true as boolean,
    peakConfirmFrames: 1 as number,
    peakConfirmDrop: 1 as number,
    /** Past the peak the hand must be heading back toward rest (cosine to the way home) or nearly stopped. */
    peakReturnCos: 0.5 as number,
    /** Gate: a punch travels at least this far from rest, at least this fast at some point. */
    minTravel: 0.55,
    minPeakSpeed: 4.0,
    /** Frame-gap correction for the speed gate: none up to gapBoostFromMs, then the measured speed is
     *  divided by 1 - (gap - from) / span, at most by gapBoostMin. */
    gapBoostFromMs: 50 as number,
    gapBoostSpanMs: 350 as number,
    gapBoostMin: 0.75 as number,
    /** Not a punch when the hand moves mostly up or down (bothHandsVertical times more than sideways) and the
     *  other hand moves the same way by at least bothHandsFraction as much: raising or dropping the guard. */
    bothHandsVertical: 1.5,
    bothHandsFraction: 0.6,
    /** After a motion, the hand is back once within returnDist (or returnFraction of the motion) of rest, or has settled for settleMs. */
    returnDist: 0.35,
    returnFraction: 0.45,
    settleMs: 350,
    /** Settling after a motion that did not fire (nothing to retract, so a shorter pause will do). */
    settleIgnoredMs: 100 as number,
    /**
     * Doubles and combos: a hand on its way back that turns round (slows under relaunchStillSpeed,
     * or leaves in a direction at most relaunchTurnCos to the one it came in on: 0 is a right
     * angle) and moves relaunchDist away from that point at punch speed
     * starts a new motion from there, without first going home or settling. After a fired punch
     * the hand must have come back past relaunchBack of it, and the next punch still fires no
     * sooner than cooldownMs after the last.
     */
    relaunch: true as boolean,
    relaunchTurnCos: 0 as number,
    relaunchStillSpeed: 2.0 as number,
    relaunchDist: 0.35 as number,
    relaunchBack: 0.8 as number,
    cooldownMs: 250,
    gassedCooldownMs: 450,
    swFollowMs: 1_000,
    /**
     * Body shots are thrown crouched: a punch is a body shot when the head dips at least bodyDip
     * (sw below the neutral head position) by its peak, otherwise a head shot. Calibration sets it
     * to bodyDipFraction of the player's own crouch depth, within [bodyDipMin, bodyDipMax].
     */
    bodyDip: 0.4,
    bodyDipFraction: 0.45,
    bodyDipMin: 0.3,
    bodyDipMax: 0.8,
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
    minSweep: 0.45,
  },

  uppercut: {
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

  /** "From guard" uses the calibrated guard plus this slack. */
  gate: { guardStartSlack: 0.4, guardStartSlackY: 0.5, defaultGuardHead: 0.6, defaultGuardY: -0.2 },

  /** Per-player learned classifier, trained by the guided calibration. */
  model: {
    k: 1,
    /** Reject a motion when it is further from its nearest taught punch than this multiple of the
     *  typical spacing between taught reps of the same punch. */
    rejectScale: 3,
    minRadius: 3.5,
    /** Floor for each feature's spread when standardizing (feature units, mostly sw). */
    minStd: 0.1,
    /** A hook or uppercut within this factor of the nearest straight's distance is read as the straight. */
    straightMargin: 1.0,
    /** Verify: a punch read as no punch drops at most this many of the non-punch examples nearest to it. */
    maxShadowDrop: 2,
    repsPerMove: 5,
    /** Reps of each standing punch thrown as fast as possible, right after its normal reps. */
    fastReps: 3,
    /** In a fast step, motions closer together than this are one attempt (fast reps follow each other closely). */
    fastAttemptGapMs: 100,
    /** Combo step: combos to collect, and the most time between punch peaks within one combo. */
    comboReps: 3,
    comboGapMs: 700,
    /** Motions of one hand closer together than this are one attempt (wind-up, punch, overshoot). */
    attemptGapMs: 250,
    /** The punch in an attempt is its last motion travelling at least this fraction of the biggest. */
    attemptRepFraction: 0.7,
    /** An attempt counts as a rep when it travels at least this fraction of the typical attempt. */
    minRepFraction: 0.6,
    /** Motions in the first moments of a step belong to the previous step (or to reading the prompt). */
    stepGraceMs: 700,
    /** A step moves on this long after its last rep, so the return to guard is not cut off. */
    settleAfterRepMs: 400,
    moveTimeoutMs: 15_000,
    /** A taught rep further from its own move than this multiple of the typical spacing is dropped. */
    outlierScale: 3.5,
    outlierMinDist: 3,
    /** Verify: each move must be read right verifyPasses times, within verifyMaxTries attempts. */
    verifyPasses: 2,
    verifyMaxTries: 4,
    verifyPromptMs: 6_000,
    verifyFeedbackMs: 1_300,
    /** Duck and slip thresholds as a fraction of the player's own demonstrated depth. */
    defenseFraction: 0.5,
  },

  network: { poseHz: 20 },
} as const;
