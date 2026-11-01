import type { MultiTrack, TimeSelection } from './MultiTrackPlayer.ts';

export interface MultiTrackRenderOptions {
  canvas: HTMLCanvasElement;
  tracks: MultiTrack[];
  totalDuration: number;
  playheadSec: number;
  hoverSec?: number | null;
  selection?: TimeSelection | null;
  showDtmf?: boolean;
}

export class MultiTrackRenderer {
  private static HEADER_HEIGHT = 28;
  private static TRACK_HEIGHT = 52;

  public static render(options: MultiTrackRenderOptions): void {
    const { canvas, tracks, totalDuration, playheadSec, hoverSec, selection } = options;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const headerH = MultiTrackRenderer.HEADER_HEIGHT;
    const trackH = MultiTrackRenderer.TRACK_HEIGHT;

    // 1. Draw Timeline Ruler Header
    ctx.fillStyle = '#16161e';
    ctx.fillRect(0, 0, w, headerH);
    ctx.fillStyle = '#24283b';
    ctx.fillRect(0, headerH - 1, w, 1);

    // Time ticks and labels
    if (totalDuration > 0) {
      const stepSec = totalDuration > 30 ? 5 : 2;
      ctx.font = '10px Consolas, monospace';
      ctx.textAlign = 'center';

      for (let sec = 0; sec <= totalDuration + 0.1; sec += stepSec) {
        const x = (sec / totalDuration) * w;
        if (x > w) break;

        // Tick mark
        ctx.fillStyle = '#414868';
        ctx.fillRect(x, headerH - 6, 1, 6);

        // Tick text
        ctx.fillStyle = '#787c99';
        ctx.fillText(`${sec.toFixed(0)}s`, x, headerH / 2);

        // Vertical background grid line down all tracks
        ctx.fillStyle = 'rgba(65, 72, 104, 0.18)';
        ctx.fillRect(x, headerH, 1, h - headerH);
      }
    }

    // 2. Draw Track Rows
    const hasSolo = tracks.some(t => t.isSolo);

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const y = headerH + i * trackH;
      const isEffectiveMuted = hasSolo ? !track.isSolo : track.isMuted;

      // Track row background (alternating shades)
      ctx.fillStyle = i % 2 === 0 ? '#1a1b26' : '#181924';
      ctx.fillRect(0, y, w, trackH);

      // Bottom track separator line
      ctx.fillStyle = '#24283b';
      ctx.fillRect(0, y + trackH - 1, w, 1);

      const midY = y + trackH / 2;

      // Draw Waveform inside track timeline
      if (totalDuration > 0) {
        const xStart = (track.relativeStartTime / totalDuration) * w;
        const trackSec = track.pcm16 && track.pcm16.length > 0 && track.sampleRate > 0
          ? track.pcm16.length / track.sampleRate
          : Math.max(0.1, track.duration);
        const xEnd = Math.min(w, Math.max(xStart + 3, ((track.relativeStartTime + trackSec) / totalDuration) * w));
        const waveW = Math.max(3, xEnd - xStart);

        // 1. Draw Active Audio Clip Container Box
        ctx.fillStyle = isEffectiveMuted
          ? 'rgba(65, 72, 104, 0.15)'
          : 'rgba(122, 162, 247, 0.08)';
        ctx.fillRect(xStart, y + 4, waveW, trackH - 8);

        ctx.strokeStyle = isEffectiveMuted
          ? 'rgba(86, 95, 137, 0.3)'
          : (track.isSolo ? '#e0af68' : 'rgba(122, 162, 247, 0.25)');
        ctx.lineWidth = 1;
        ctx.strokeRect(xStart, y + 4, waveW, trackH - 8);

        // 2. Waveform baseline
        ctx.fillStyle = isEffectiveMuted
          ? 'rgba(86, 95, 137, 0.5)'
          : track.color;
        ctx.fillRect(xStart, midY - 0.5, waveW, 1);

        // 3. Draw Waveform Peaks
        const peaks = track.peaks;
        if (peaks && peaks.length > 0) {
          const barWidth = waveW / peaks.length;
          const maxPeak = Math.max(...peaks);
          // Auto-boost low amplitudes (e.g. quiet comfort noise/VAD) so silence is visible
          const normFactor = maxPeak > 0.05 ? 1.0 : (maxPeak > 0.00001 ? 0.25 / maxPeak : 1.0);

          ctx.fillStyle = isEffectiveMuted
            ? 'rgba(86, 95, 137, 0.4)'
            : track.color;

          for (let p = 0; p < peaks.length; p++) {
            const rawPeak = peaks[p];
            if (rawPeak <= 0.000001) continue;
            const peak = Math.min(1.0, rawPeak * normFactor);
            const barH = Math.max(2, peak * (trackH - 14));
            const bx = xStart + p * barWidth;
            const by = midY - barH / 2;
            ctx.fillRect(bx, by, Math.max(1, barWidth - 0.5), barH);
          }
        }

        // 4. If track is soloed, render subtle glowing outline
        if (track.isSolo) {
          ctx.strokeStyle = '#e0af68';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(xStart - 1, y + 3, waveW + 2, trackH - 6);
        }

        // 5. Draw DTMF Keypad Events if enabled and present
        if (options.showDtmf && track.telephoneEvents && track.telephoneEvents.length > 0) {
          const uniqueEvents: Array<{ digit: string; time: number }> = [];
          for (const ev of track.telephoneEvents) {
            const digit = ev.event === 10 ? '*' : ev.event === 11 ? '#' : ev.event >= 12 ? String.fromCharCode(65 + ev.event - 12) : String(ev.event);
            const last = uniqueEvents[uniqueEvents.length - 1];
            if (!last || last.digit !== digit || Math.abs(ev.time - last.time) > 0.4) {
              uniqueEvents.push({ digit, time: ev.time });
            }
          }

          for (const uev of uniqueEvents) {
            const evOffsetSec = Math.max(0, uev.time - track.startTime);
            const evSec = track.relativeStartTime + evOffsetSec;
            if (evSec < 0 || evSec > totalDuration) continue;
            const evX = (evSec / totalDuration) * w;

            // Vertical marker line
            ctx.fillStyle = '#e0af68';
            ctx.fillRect(evX - 1, y + 2, 2, trackH - 4);

            // DTMF badge pill
            const pillW = 20;
            const pillH = 13;
            const pillX = Math.min(w - pillW - 2, Math.max(2, evX - pillW / 2));
            const pillY = y + 4;
            ctx.fillStyle = '#1f2335';
            ctx.fillRect(pillX, pillY, pillW, pillH);
            ctx.strokeStyle = '#e0af68';
            ctx.lineWidth = 1;
            ctx.strokeRect(pillX, pillY, pillW, pillH);

            ctx.fillStyle = '#e0af68';
            ctx.font = 'bold 9px Consolas, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`⌗${uev.digit}`, pillX + pillW / 2, pillY + pillH / 2);
          }
        }
      }
    }

    // 3. Draw GoldWave-style Time Selection Region
    if (totalDuration > 0 && selection && selection.endSec > selection.startSec) {
      const selStart = Math.max(0, Math.min(totalDuration, selection.startSec));
      const selEnd = Math.max(0, Math.min(totalDuration, selection.endSec));
      const x1 = (selStart / totalDuration) * w;
      const x2 = (selEnd / totalDuration) * w;
      const selWidth = Math.max(1, x2 - x1);

      ctx.save();

      // Semi-transparent vibrant GoldWave blue tint across all tracks
      ctx.fillStyle = 'rgba(30, 95, 235, 0.28)';
      ctx.fillRect(x1, 0, selWidth, h);

      // Top ruler highlight tint
      ctx.fillStyle = 'rgba(65, 140, 255, 0.38)';
      ctx.fillRect(x1, 0, selWidth, headerH);

      // Left boundary line (bright cyan)
      ctx.fillStyle = '#2ac3de';
      ctx.fillRect(x1 - 1, 0, 2, h);

      // Right boundary line (bright cyan)
      ctx.fillStyle = '#2ac3de';
      ctx.fillRect(x2 - 1, 0, 2, h);

      // Start Handle Marker '{' at ruler (GoldWave style)
      ctx.fillStyle = '#2ac3de';
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x1 - 13, 3, 13, headerH - 6, [4, 0, 0, 4]);
      } else {
        ctx.rect(x1 - 13, 3, 13, headerH - 6);
      }
      ctx.fill();
      ctx.fillStyle = '#16161e';
      ctx.font = 'bold 11px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('{', x1 - 6.5, headerH / 2);

      // End Handle Marker '}' at ruler (GoldWave style)
      ctx.fillStyle = '#2ac3de';
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x2, 3, 13, headerH - 6, [0, 4, 4, 0]);
      } else {
        ctx.rect(x2, 3, 13, headerH - 6);
      }
      ctx.fill();
      ctx.fillStyle = '#16161e';
      ctx.font = 'bold 11px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('}', x2 + 6.5, headerH / 2);

      // Selection duration & time badge in ruler header if width permits
      if (selWidth > 64) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${(selEnd - selStart).toFixed(2)}s`, x1 + selWidth / 2, headerH / 2);
      }

      ctx.restore();
    }

    // 4. Hover Guide (if active)
    if (hoverSec !== null && hoverSec !== undefined && hoverSec >= 0 && hoverSec <= totalDuration) {
      const hoverX = (hoverSec / totalDuration) * w;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fillRect(hoverX, headerH, 1, h - headerH);
    }

    // 5. Master Synchronized Green Playhead Needle (Wireshark-style)
    if (totalDuration > 0) {
      const clampedPlayhead = Math.max(0, Math.min(totalDuration, playheadSec));
      const playheadX = (clampedPlayhead / totalDuration) * w;

      ctx.save();
      // Glow effect
      ctx.shadowColor = 'rgba(65, 245, 130, 0.8)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#41f582'; // Bright Fluorescent Green
      ctx.fillRect(playheadX - 1, 0, 2, h);

      // Needle handle at the ruler
      ctx.beginPath();
      ctx.arc(playheadX, headerH / 2, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  public static getNearHandle(
    e: MouseEvent,
    canvas: HTMLCanvasElement,
    totalDuration: number,
    selection?: TimeSelection | null
  ): 'start' | 'end' | null {
    if (!selection || totalDuration <= 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const mouseX = e.clientX - rect.left;
    const x1 = (selection.startSec / totalDuration) * rect.width;
    const x2 = (selection.endSec / totalDuration) * rect.width;

    if (Math.abs(mouseX - x1) <= 9) return 'start';
    if (Math.abs(mouseX - x2) <= 9) return 'end';
    return null;
  }

  public static getSecFromEvent(e: MouseEvent, canvas: HTMLCanvasElement, totalDuration: number): number | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const clickX = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    return pct * totalDuration;
  }
}
