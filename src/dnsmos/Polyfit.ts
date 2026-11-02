/**
 * Polyfit.ts
 * Exact polynomial calibration equations mapping raw model outputs to P.835 Mean Opinion Scores.
 * Source: official Microsoft DNS-Challenge dnsmos_local.py
 */

export class Polyfit {
  /**
   * Applies polynomial fit to map raw (SIG, BAK, OVRL) model outputs to calibrated human ratings (1.0 to 5.0).
   */
  public static fit(
    rawSig: number,
    rawBak: number,
    rawOvr: number,
    isPersonalized: boolean = false
  ): { sig: number; bak: number; ovrl: number } {
    let sig: number;
    let bak: number;
    let ovrl: number;

    if (isPersonalized) {
      // Cubic polynomials for personalized MOS
      // p_ovr = [-0.00533021, 0.005101, 1.18058466, -0.11236046]
      ovrl = -0.00533021 * Math.pow(rawOvr, 3) + 0.005101 * Math.pow(rawOvr, 2) + 1.18058466 * rawOvr - 0.11236046;

      // p_sig = [-0.01019296, 0.02751166, 1.19576786, -0.24348726]
      sig = -0.01019296 * Math.pow(rawSig, 3) + 0.02751166 * Math.pow(rawSig, 2) + 1.19576786 * rawSig - 0.24348726;

      // p_bak = [-0.04976499, 0.44276479, -0.1644611, 0.96883132]
      bak = -0.04976499 * Math.pow(rawBak, 3) + 0.44276479 * Math.pow(rawBak, 2) - 0.1644611 * rawBak + 0.96883132;
    } else {
      // Quadratic polynomials for regular standard DNSMOS
      // p_ovr = [-0.06766283, 1.11546468, 0.04602535]
      ovrl = -0.06766283 * Math.pow(rawOvr, 2) + 1.11546468 * rawOvr + 0.04602535;

      // p_sig = [-0.08397278, 1.22083953, 0.0052439]
      sig = -0.08397278 * Math.pow(rawSig, 2) + 1.22083953 * rawSig + 0.0052439;

      // p_bak = [-0.13166888, 1.60915514, -0.39604546]
      bak = -0.13166888 * Math.pow(rawBak, 2) + 1.60915514 * rawBak - 0.39604546;
    }

    // ITU-T P.835 valid range clamp: [1.0, 5.0]
    return {
      sig: Math.max(1.0, Math.min(5.0, Number(sig.toFixed(4)))),
      bak: Math.max(1.0, Math.min(5.0, Number(bak.toFixed(4)))),
      ovrl: Math.max(1.0, Math.min(5.0, Number(ovrl.toFixed(4)))),
    };
  }
}
