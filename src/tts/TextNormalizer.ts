/**
 * TextNormalizer.ts
 * Multilingual rule-based text normalizer for Text-to-Speech synthesis.
 * Normalizes numbers, dates, currency symbols, percentages, and common telephony abbreviations
 * across English (US/IN), Spanish, Turkish, French, German, Arabic, and Polish.
 */

export class TextNormalizer {
  /**
   * Normalizes input text according to the target language conventions.
   */
  public static normalize(text: string, language: string): string {
    if (!text || text.trim().length === 0) return '';

    let res = text.trim();
    const lang = language.toLowerCase();

    if (lang.startsWith('en')) {
      res = this.normalizeEnglish(res);
    } else if (lang.startsWith('es')) {
      res = this.normalizeSpanish(res);
    } else if (lang.startsWith('fr')) {
      res = this.normalizeFrench(res);
    } else if (lang.startsWith('de')) {
      res = this.normalizeGerman(res);
    } else if (lang.startsWith('tr')) {
      res = this.normalizeTurkish(res);
    } else if (lang.startsWith('ar')) {
      res = this.normalizeArabic(res);
    } else if (lang.startsWith('pl')) {
      res = this.normalizePolish(res);
    }

    // Collapse multiple whitespaces
    return res.replace(/\s+/g, ' ').trim();
  }

  private static normalizeEnglish(text: string): string {
    let s = text;
    // Currencies
    s = s.replace(/\$(\d+)\.(\d{2})\b/g, '$1 dollars and $2 cents');
    s = s.replace(/\$(\d+)\b/g, '$1 dollars');
    s = s.replace(/£(\d+)\b/g, '$1 pounds');
    s = s.replace(/€(\d+)\b/g, '$1 euros');
    s = s.replace(/₹(\d+)\b/g, '$1 rupees');
    s = s.replace(/(\d+)%/g, '$1 percent');

    // Telephony / common abbreviations
    s = s.replace(/\bext\.?\s*(\d+)/gi, 'extension $1');
    s = s.replace(/\bdept\.?/gi, 'department');
    s = s.replace(/\bapt\.?\s*(\d+)/gi, 'apartment $1');
    s = s.replace(/\bno\.?\s*(\d+)/gi, 'number $1');
    s = s.replace(/\bdr\.?\s+/gi, 'Doctor ');
    s = s.replace(/\bmr\.?\s+/gi, 'Mister ');
    s = s.replace(/\bmrs\.?\s+/gi, 'Missus ');
    s = s.replace(/\bms\.?\s+/gi, 'Miz ');
    s = s.replace(/\bmin\.?\b/gi, 'minutes');
    s = s.replace(/\bsec\.?\b/gi, 'seconds');
    s = s.replace(/\bapprox\.?/gi, 'approximately');
    s = s.replace(/\btel\.?/gi, 'telephone');

    return s;
  }

  private static normalizeSpanish(text: string): string {
    let s = text;
    s = s.replace(/(\d+)\s*€/g, '$1 euros');
    s = s.replace(/€(\d+)\b/g, '$1 euros');
    s = s.replace(/\$(\d+)\b/g, '$1 pesos');
    s = s.replace(/(\d+)%/g, '$1 por ciento');

    s = s.replace(/\bn[ºo]\.?\s*(\d+)/gi, 'número $1');
    s = s.replace(/\bext\.?\s*(\d+)/gi, 'extensión $1');
    s = s.replace(/\bdpto\.?/gi, 'departamento');
    s = s.replace(/\bsr\.?\s+/gi, 'Señor ');
    s = s.replace(/\bsra\.?\s+/gi, 'Señora ');
    s = s.replace(/\bdr\.?\s+/gi, 'Doctor ');
    s = s.replace(/\baprox\.?/gi, 'aproximadamente');
    s = s.replace(/\btelf\.?/gi, 'teléfono');

    return s;
  }

  private static normalizeFrench(text: string): string {
    let s = text;
    s = s.replace(/(\d+)\s*€/g, '$1 euros');
    s = s.replace(/€(\d+)\b/g, '$1 euros');
    s = s.replace(/(\d+)%/g, '$1 pour cent');

    s = s.replace(/\bn[°o]\.?\s*(\d+)/gi, 'numéro $1');
    s = s.replace(/\bm\.?\s+/gi, 'Monsieur ');
    s = s.replace(/\bmme\.?\s+/gi, 'Madame ');
    s = s.replace(/\bdr\.?\s+/gi, 'Docteur ');
    s = s.replace(/\btél\.?/gi, 'téléphone');
    s = s.replace(/\bposte\s*(\d+)/gi, 'poste $1');

    return s;
  }

  private static normalizeGerman(text: string): string {
    let s = text;
    s = s.replace(/(\d+)\s*€/g, '$1 Euro');
    s = s.replace(/€(\d+)\b/g, '$1 Euro');
    s = s.replace(/(\d+)%/g, '$1 Prozent');

    s = s.replace(/\bnr\.?\s*(\d+)/gi, 'Nummer $1');
    s = s.replace(/\bdr\.?\s+/gi, 'Doktor ');
    s = s.replace(/\bhr\.?\s+/gi, 'Herr ');
    s = s.replace(/\bfr\.?\s+/gi, 'Frau ');
    s = s.replace(/\bca\.?/gi, 'circa');
    s = s.replace(/\btel\.?/gi, 'Telefon');

    return s;
  }

  private static normalizeTurkish(text: string): string {
    let s = text;
    s = s.replace(/(\d+)\s*(?:TL|₺)/gi, '$1 Türk Lirası');
    s = s.replace(/%(\d+)/g, 'yüzde $1');
    s = s.replace(/(\d+)%/g, 'yüzde $1');

    s = s.replace(/\bno\.?\s*(\d+)/gi, 'numara $1');
    s = s.replace(/\bdr\.?\s+/gi, 'Doktor ');
    s = s.replace(/\bdk\.?/gi, 'dakika');
    s = s.replace(/\bsn\.?/gi, 'saniye');
    s = s.replace(/\btel\.?/gi, 'telefon');

    return s;
  }

  private static normalizeArabic(text: string): string {
    let s = text;
    // Normalize Eastern Arabic numerals to standard Arabic-Indic digits if needed
    const easternToWestern: Record<string, string> = {
      '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
      '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
    };
    s = s.replace(/[٠-٩]/g, (d) => easternToWestern[d] || d);

    s = s.replace(/(\d+)\s*%/g, '$1 بالمئة');
    s = s.replace(/(\d+)\s*ر\.س/g, '$1 ريال سعودي');
    s = s.replace(/(\d+)\s*د\.أ/g, '$1 دينار أردني');
    s = s.replace(/(\d+)\s*ج\.م/g, '$1 جنيه مصري');

    s = s.replace(/\bرقم\s*(\d+)/g, 'رقم $1');
    s = s.replace(/\bد\.?\s+/g, 'دكتور ');
    s = s.replace(/\bأ\.?\s+/g, 'أستاذ ');

    return s;
  }

  private static normalizePolish(text: string): string {
    let s = text;
    s = s.replace(/(\d+)\s*(?:zł|PLN)(?!\w)/gi, '$1 złotych');
    s = s.replace(/(\d+)%/g, '$1 procent');

    s = s.replace(/\bnr\.?\s+/gi, 'numer ');
    s = s.replace(/\bul\.?\s+/gi, 'ulica ');
    s = s.replace(/\bdr\.?\s+/gi, 'doktor ');
    s = s.replace(/\bgodz\.?\s*(\d+)/gi, 'godzina $1');
    s = s.replace(/\btel\.?/gi, 'telefon');

    return s;
  }
}
