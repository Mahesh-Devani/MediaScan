/**
 * AudioDspEngine.ts
 * Core DSP processing engine for Audio Editor.
 * Includes Gain/Amplify, Peak/Loudness Normalization, Fades, Inversion, Reversal,
 * DC offset removal, and Telephony Signal Generators (DTMF, tones, noise).
 */

export interface DtmfParams {
  digit: string; // 0-9, *, #, A-D
  durationMs: number; // e.g. 100ms
  silenceMs?: number; // e.g. 50ms
  twistDb?: number; // High-group vs low-group twist (-3 to +3 dB)
  sampleRate: number;
}

export interface CallProgressToneParams {
  type: 'dial' | 'ringback' | 'busy' | 'reorder';
  durationSec: number;
  sampleRate: number;
}

export class AudioDspEngine {
  /**
   * Apply gain in decibels to Float32Array channel data in place.
   */
  public static applyGainDb(channels: Float32Array[], gainDb: number): Float32Array[] {
    const factor = Math.pow(10, gainDb / 20);
    return this.applyGainFactor(channels, factor);
  }

  /**
   * Apply linear gain factor to Float32Array channel data in place.
   */
  public static applyGainFactor(channels: Float32Array[], factor: number): Float32Array[] {
    const out = channels.map(ch => {
      const copy = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        copy[i] = ch[i] * factor;
      }
      return copy;
    });
    return out;
  }

  /**
   * Peak normalize to target dBFS (e.g. -1.0 dBFS).
   */
  public static peakNormalize(channels: Float32Array[], targetDbfs: number = -1.0): {
    channels: Float32Array[];
    appliedGainDb: number;
    initialPeakDbfs: number;
  } {
    let globalPeak = 0;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        const absVal = Math.abs(ch[i]);
        if (absVal > globalPeak) globalPeak = absVal;
      }
    }

    const initialPeakDbfs = globalPeak > 1e-6 ? 20 * Math.log10(globalPeak) : -96.0;
    if (globalPeak <= 1e-6) {
      return { channels: channels.map(ch => new Float32Array(ch)), appliedGainDb: 0, initialPeakDbfs };
    }

    const targetLinear = Math.pow(10, targetDbfs / 20);
    const factor = targetLinear / globalPeak;
    const appliedGainDb = 20 * Math.log10(factor);

    return {
      channels: this.applyGainFactor(channels, factor),
      appliedGainDb: Math.round(appliedGainDb * 100) / 100,
      initialPeakDbfs: Math.round(initialPeakDbfs * 100) / 100
    };
  }

  /**
   * Loudness normalize targeting dBov (e.g. -26 dBov for telecom RTP compliance).
   * dBov definition: 0 dBov is power of full-scale square wave, or -3.01 dBFS for pure sine.
   */
  public static loudnessNormalize(channels: Float32Array[], targetDbov: number = -26.0): {
    channels: Float32Array[];
    appliedGainDb: number;
  } {
    // Compute RMS across channels
    let sumSq = 0;
    let totalSamples = 0;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        sumSq += ch[i] * ch[i];
      }
      totalSamples += ch.length;
    }

    const rms = totalSamples > 0 ? Math.sqrt(sumSq / totalSamples) : 0;
    // Current dBov = 10 * log10(RMS^2)
    const currentDbov = rms > 1e-6 ? 20 * Math.log10(rms) : -96.0;
    const appliedGainDb = targetDbov - currentDbov;
    const factor = Math.pow(10, appliedGainDb / 20);

    return {
      channels: this.applyGainFactor(channels, factor),
      appliedGainDb: Math.round(appliedGainDb * 100) / 100
    };
  }

  /**
   * Fade in or fade out over samples.
   */
  public static applyFade(
    channels: Float32Array[],
    direction: 'in' | 'out',
    curve: 'linear' | 'log' | 's-curve' = 'linear'
  ): Float32Array[] {
    const len = channels[0] ? channels[0].length : 0;
    if (len === 0) return channels;

    return channels.map(ch => {
      const copy = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        let t = i / (len - 1 || 1);
        if (direction === 'out') t = 1.0 - t;

        let multiplier = t;
        if (curve === 's-curve') {
          // Half cosine smoothstep
          multiplier = 0.5 * (1 - Math.cos(Math.PI * t));
        } else if (curve === 'log') {
          // Exponential / logarithmic
          multiplier = Math.pow(t, 2);
        }

        copy[i] = ch[i] * multiplier;
      }
      return copy;
    });
  }

  /**
   * Invert polarity (multiply by -1.0).
   */
  public static invertPolarity(channels: Float32Array[]): Float32Array[] {
    return channels.map(ch => {
      const copy = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        copy[i] = -ch[i];
      }
      return copy;
    });
  }

  /**
   * Reverse audio channel in time.
   */
  public static reverse(channels: Float32Array[]): Float32Array[] {
    return channels.map(ch => {
      const copy = new Float32Array(ch.length);
      const len = ch.length;
      for (let i = 0; i < len; i++) {
        copy[i] = ch[len - 1 - i];
      }
      return copy;
    });
  }

  /**
   * Remove DC offset by subtracting channel mean.
   */
  public static removeDcOffset(channels: Float32Array[]): Float32Array[] {
    return channels.map(ch => {
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i];
      const mean = ch.length > 0 ? sum / ch.length : 0;

      const copy = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) copy[i] = ch[i] - mean;
      return copy;
    });
  }

  /**
   * Generate silence buffer.
   */
  public static generateSilence(
    durationSec: number,
    sampleRate: number,
    numChannels: number = 1
  ): Float32Array[] {
    const numSamples = Math.floor(durationSec * sampleRate);
    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(new Float32Array(numSamples));
    }
    return channels;
  }

  /**
   * Generate pure sine tone.
   */
  public static generateSine(
    frequencyHz: number,
    durationSec: number,
    sampleRate: number,
    amplitude: number = 0.5,
    numChannels: number = 1
  ): Float32Array[] {
    const numSamples = Math.floor(durationSec * sampleRate);
    const mono = new Float32Array(numSamples);
    const omega = (2 * Math.PI * frequencyHz) / sampleRate;

    for (let i = 0; i < numSamples; i++) {
      mono[i] = Math.sin(omega * i) * amplitude;
    }

    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(c === 0 ? mono : new Float32Array(mono));
    }
    return channels;
  }

  /**
   * Generate ITU-T Q.23 DTMF digit tone.
   * Low frequencies: 697, 770, 852, 941 Hz
   * High frequencies: 1209, 1336, 1477, 1633 Hz
   */
  public static generateDtmf(params: DtmfParams): Float32Array[] {
    const dtmfFreqs: Record<string, [number, number]> = {
      '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633],
      '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
      '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633],
      '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633]
    };

    const freqs = dtmfFreqs[params.digit.toUpperCase()] || [941, 1336];
    const [fLow, fHigh] = freqs;

    const toneSamples = Math.floor((params.durationMs / 1000) * params.sampleRate);
    const silenceSamples = params.silenceMs ? Math.floor((params.silenceMs / 1000) * params.sampleRate) : 0;
    const totalSamples = toneSamples + silenceSamples;

    const mono = new Float32Array(totalSamples);
    const twistDb = params.twistDb || 0;
    // Twist applies relative gain to high group (standard allows +1 to +3 dB forward twist)
    const highGain = Math.pow(10, twistDb / 20);
    const lowAmp = 0.35;
    const highAmp = 0.35 * highGain;

    const omegaLow = (2 * Math.PI * fLow) / params.sampleRate;
    const omegaHigh = (2 * Math.PI * fHigh) / params.sampleRate;

    for (let i = 0; i < toneSamples; i++) {
      mono[i] = Math.sin(omegaLow * i) * lowAmp + Math.sin(omegaHigh * i) * highAmp;
    }

    return [mono];
  }

  /**
   * Generate Call Progress Tones (US standard frequencies & cadences).
   * - Dial tone: 350 Hz + 440 Hz continuous
   * - Ringback: 440 Hz + 480 Hz (2.0s on, 4.0s off)
   * - Busy: 480 Hz + 620 Hz (0.5s on, 0.5s off)
   * - Reorder / Fast Busy: 480 Hz + 620 Hz (0.25s on, 0.25s off)
   */
  public static generateCallProgressTone(params: CallProgressToneParams): Float32Array[] {
    const totalSamples = Math.floor(params.durationSec * params.sampleRate);
    const mono = new Float32Array(totalSamples);

    let f1 = 350;
    let f2 = 440;
    let periodSamples = 0;
    let onSamples = 0;

    switch (params.type) {
      case 'dial':
        f1 = 350; f2 = 440;
        onSamples = totalSamples;
        periodSamples = totalSamples;
        break;
      case 'ringback':
        f1 = 440; f2 = 480;
        onSamples = Math.floor(2.0 * params.sampleRate);
        periodSamples = Math.floor(6.0 * params.sampleRate);
        break;
      case 'busy':
        f1 = 480; f2 = 620;
        onSamples = Math.floor(0.5 * params.sampleRate);
        periodSamples = Math.floor(1.0 * params.sampleRate);
        break;
      case 'reorder':
        f1 = 480; f2 = 620;
        onSamples = Math.floor(0.25 * params.sampleRate);
        periodSamples = Math.floor(0.5 * params.sampleRate);
        break;
    }

    const w1 = (2 * Math.PI * f1) / params.sampleRate;
    const w2 = (2 * Math.PI * f2) / params.sampleRate;

    for (let i = 0; i < totalSamples; i++) {
      const cycleIdx = periodSamples > 0 ? i % periodSamples : i;
      if (cycleIdx < onSamples) {
        mono[i] = 0.3 * (Math.sin(w1 * i) + Math.sin(w2 * i));
      } else {
        mono[i] = 0.0;
      }
    }

    return [mono];
  }

  /**
   * Generate White or Pink Noise.
   */
  public static generateNoise(
    type: 'white' | 'pink',
    durationSec: number,
    sampleRate: number,
    amplitude: number = 0.2
  ): Float32Array[] {
    const totalSamples = Math.floor(durationSec * sampleRate);
    const mono = new Float32Array(totalSamples);

    if (type === 'white') {
      for (let i = 0; i < totalSamples; i++) {
        mono[i] = (Math.random() * 2 - 1) * amplitude;
      }
    } else {
      // Voss-McCartney 1/f Pink Noise algorithm
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < totalSamples; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
        mono[i] = (pink * 0.11) * amplitude;
      }
    }

    return [mono];
  }

  /**
   * Add noise to speech at a target SNR (dB).
   */
  public static addNoiseAtTargetSnr(
    speech: Float32Array[],
    noise: Float32Array[],
    targetSnrDb: number
  ): Float32Array[] {
    const len = speech[0] ? speech[0].length : 0;
    if (len === 0) return speech;

    // Calculate speech power
    let speechSumSq = 0;
    for (let i = 0; i < len; i++) {
      speechSumSq += speech[0][i] * speech[0][i];
    }
    const speechPower = speechSumSq / len;
    if (speechPower < 1e-8) {
      return speech; // Silence speech, don't scale
    }

    // Required noise power: SNR = 10 * log10(speechPower / noisePower) => noisePower = speechPower / 10^(SNR/10)
    const requiredNoisePower = speechPower / Math.pow(10, targetSnrDb / 10);
    const targetNoiseRms = Math.sqrt(requiredNoisePower);

    // Calculate current noise power
    const noiseLen = noise[0] ? noise[0].length : 0;
    let noiseSumSq = 0;
    for (let i = 0; i < noiseLen; i++) {
      noiseSumSq += noise[0][i] * noise[0][i];
    }
    const currentNoiseRms = noiseLen > 0 ? Math.sqrt(noiseSumSq / noiseLen) : 1e-4;
    const noiseScale = targetNoiseRms / (currentNoiseRms || 1e-4);

    return speech.map((ch, c) => {
      const noiseCh = noise[c] || noise[0];
      const mixed = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const nSample = noiseCh ? (noiseCh[i % noiseLen] || 0) * noiseScale : 0;
        mixed[i] = ch[i] + nSample;
      }
      return mixed;
    });
  }
}
