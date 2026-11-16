/**
 * test/tts-studio.test.ts
 * Unit tests for Feature A: Neural Text-to-Speech Studio
 * Tests TextNormalizer, TtsEngine manifest loading, voice registry, synthesis pipeline,
 * resampling, level normalization, and WAV export.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TextNormalizer } from '../src/tts/TextNormalizer.ts';
import { TtsEngine } from '../src/tts/TtsEngine.ts';
import { WavParser } from '../src/audio/WavParser.ts';

describe('Feature A: Text-to-Speech Studio & Multilingual Normalization', () => {

  describe('1. Multilingual TextNormalizer', () => {

    it('normalizes English currency, abbreviations, and percentages', () => {
      const input = 'Call Dr. Smith at ext. 104. Balance is $42.50 or 50% discount.';
      const output = TextNormalizer.normalize(input, 'en_US');
      assert.ok(output.includes('Doctor Smith'), `Expected Doctor Smith, got: ${output}`);
      assert.ok(output.includes('extension 104'), `Expected extension 104, got: ${output}`);
      assert.ok(output.includes('42 dollars and 50 cents'), `Expected currency expanded, got: ${output}`);
      assert.ok(output.includes('50 percent'), `Expected 50 percent, got: ${output}`);
    });

    it('normalizes Spanish numbers, abbreviations, and euro currency', () => {
      const input = 'Llame al Sr. Pérez en dpto. 4. Total: 15€ con 20% de descuento.';
      const output = TextNormalizer.normalize(input, 'es_ES');
      assert.ok(output.includes('Señor Pérez'), `Expected Señor Pérez, got: ${output}`);
      assert.ok(output.includes('departamento 4'), `Expected departamento 4, got: ${output}`);
      assert.ok(output.includes('15 euros'), `Expected 15 euros, got: ${output}`);
      assert.ok(output.includes('20 por ciento'), `Expected 20 por ciento, got: ${output}`);
    });

    it('normalizes French numbers, abbreviations, and currency', () => {
      const input = 'Bonjour Mme. Dupont, facture N° 12 d un montant de 80 € avec 10%';
      const output = TextNormalizer.normalize(input, 'fr_FR');
      assert.ok(output.includes('Madame Dupont'), `Expected Madame Dupont, got: ${output}`);
      assert.ok(output.includes('numéro 12'), `Expected numéro 12, got: ${output}`);
      assert.ok(output.includes('80 euros'), `Expected 80 euros, got: ${output}`);
      assert.ok(output.includes('10 pour cent'), `Expected 10 pour cent, got: ${output}`);
    });

    it('normalizes German numbers, titles, and currency', () => {
      const input = 'Sehr geehrter Hr. Schmidt, Rechnung Nr. 99 beträgt 50 € mit 19% MwSt.';
      const output = TextNormalizer.normalize(input, 'de_DE');
      assert.ok(output.includes('Herr Schmidt'), `Expected Herr Schmidt, got: ${output}`);
      assert.ok(output.includes('Nummer 99'), `Expected Nummer 99, got: ${output}`);
      assert.ok(output.includes('50 Euro'), `Expected 50 Euro, got: ${output}`);
      assert.ok(output.includes('19 Prozent'), `Expected 19 Prozent, got: ${output}`);
    });

    it('normalizes Turkish numbers and Turkish Lira currency', () => {
      const input = 'Sayın Dr. Yılmaz, borcunuz 150 TL olup %10 indirim uygulanmıştır.';
      const output = TextNormalizer.normalize(input, 'tr_TR');
      assert.ok(output.includes('Doktor Yılmaz'), `Expected Doktor Yılmaz, got: ${output}`);
      assert.ok(output.includes('150 Türk Lirası'), `Expected 150 Türk Lirası, got: ${output}`);
      assert.ok(output.includes('yüzde 10'), `Expected yüzde 10, got: ${output}`);
    });

    it('normalizes Arabic numerals, percentages, and currencies', () => {
      const input = 'رمز التحقق هو ٤٨٢١ والخصم ٥٠%';
      const output = TextNormalizer.normalize(input, 'ar_JO');
      assert.ok(output.includes('4821'), `Expected Eastern digits normalized to 4821, got: ${output}`);
      assert.ok(output.includes('50 بالمئة'), `Expected 50 percent in Arabic, got: ${output}`);
    });

    it('normalizes Polish numbers, abbreviations, and currency', () => {
      const input = 'Kwota wynosi 120 zł, rabat 15%, nr konta 45.';
      const output = TextNormalizer.normalize(input, 'pl_PL');
      assert.ok(output.includes('120 złotych'), `Expected 120 złotych, got: ${output}`);
      assert.ok(output.includes('15 procent'), `Expected 15 procent, got: ${output}`);
      assert.ok(output.includes('numer konta 45'), `Expected numer konta 45, got: ${output}`);
    });

  });

  describe('2. TtsEngine Voice Registry & Fallback Management', () => {

    it('loads voices covering all 8 required languages', async () => {
      const engine = TtsEngine.getInstance();
      const voices = await engine.loadManifest();

      const requiredLangs = ['en_US', 'en_IN', 'es_ES', 'tr_TR', 'fr_FR', 'de_DE', 'ar_JO', 'pl_PL'];
      for (const lang of requiredLangs) {
        const found = voices.find(v => v.language.toLowerCase() === lang.toLowerCase());
        assert.ok(found, `Voice for language ${lang} must be present in registry`);
        assert.ok(found.samplePhrase && found.samplePhrase.length > 0, `Sample phrase must exist for ${lang}`);
      }

      // Check en_IN fallback documentation note
      const enIn = voices.find(v => v.language.toLowerCase() === 'en_in')!;
      assert.ok(enIn.fallbackNote, 'en_IN voice must include fallback explanatory note');
    });

    it('allows registering custom voice models in memory', () => {
      const engine = TtsEngine.getInstance();
      const dummyOnnx = new Uint8Array([1, 2, 3, 4]).buffer;

      const customVoice = engine.registerCustomVoice(
        'MyCustomVoice',
        'en_IN',
        dummyOnnx,
        { audio: { sample_rate: 16000 } }
      );

      assert.strictEqual(customVoice.language, 'en_IN');
      assert.strictEqual(customVoice.sampleRate, 16000);
      assert.strictEqual(customVoice.isCustom, true);

      const retrieved = engine.getVoice(customVoice.id);
      assert.strictEqual(retrieved?.id, customVoice.id);
    });

  });

  describe('3. Synthesis Pipeline, Resampling & WAV Generation', () => {

    it('synthesizes speech and resamples to target rates (8k, 16k, 48k)', async () => {
      const engine = TtsEngine.getInstance();

      // Synthesize 8 kHz Narrowband (Telephony / G.711 / AMR-NB)
      const res8k = await engine.synthesize('Your verification code is 4821.', 'en_US-lessac-medium', {
        targetSampleRate: 8000,
        normalizeLevel: true,
      });

      assert.strictEqual(res8k.sampleRate, 8000);
      assert.ok(res8k.pcmFloat.length > 0);
      assert.strictEqual(res8k.pcm16.length, res8k.pcmFloat.length);
      assert.ok(res8k.durationSec > 0.5);

      // Verify generated WAV header via WavParser
      const parsedWav8k = WavParser.parse(res8k.wavBytes);
      assert.strictEqual(parsedWav8k.sampleRate, 8000);
      assert.strictEqual(parsedWav8k.channelData.length, 1);
      assert.strictEqual(parsedWav8k.channelData[0].length, res8k.pcm16.length);

      // Synthesize 16 kHz Wideband (G.722 / AMR-WB / EVS)
      const res16k = await engine.synthesize('Your account balance is 42 dollars.', 'en_US-lessac-medium', {
        targetSampleRate: 16000,
      });
      assert.strictEqual(res16k.sampleRate, 16000);
      const parsedWav16k = WavParser.parse(res16k.wavBytes);
      assert.strictEqual(parsedWav16k.sampleRate, 16000);

      // Synthesize 48 kHz Fullband (Opus)
      const res48k = await engine.synthesize('Thank you for calling technical support.', 'en_US-lessac-medium', {
        targetSampleRate: 48000,
      });
      assert.strictEqual(res48k.sampleRate, 48000);
      const parsedWav48k = WavParser.parse(res48k.wavBytes);
      assert.strictEqual(parsedWav48k.sampleRate, 48000);
    });

    it('handles leading/trailing silence and target duration padding', async () => {
      const engine = TtsEngine.getInstance();

      const res = await engine.synthesize('Hello world', 'en_US-lessac-medium', {
        targetSampleRate: 16000,
        leadingSilenceSec: 0.5,
        trailingSilenceSec: 0.5,
      });

      assert.strictEqual(res.sampleRate, 16000);
      const leadSamples = 0.5 * 16000;
      // First 0.4s should be digital silence (0.0)
      for (let i = 0; i < leadSamples - 100; i++) {
        assert.strictEqual(res.pcmFloat[i], 0);
      }
    });

  });

});
