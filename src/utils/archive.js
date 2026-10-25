'use strict';

/**
 * Subtitle archive helpers shared by every proxy endpoint.
 *
 * - Detects ZIP / RAR magic bytes
 * - Extracts subtitle files (.srt, .vtt, .ass, .ssa, .sub, .smi)
 * - Picks the best entry for an episode/filename hint
 * - Converts ASS/SSA to VTT or SRT via the v1 converter
 */

const { log } = require('../../src/utils');
const { bufferToUtf8 } = require('../../src/utils/encoding');
const { convertSubtitle, convertToSrt, isAssFormat } = require('./subtitle-converter');
const { trackTypeOf } = require('./trackType');

let AdmZip = null;
try { AdmZip = require('adm-zip'); }
catch (_) { log('warn', '[archive] adm-zip not installed; ZIP extraction disabled'); }

let UnrarJs = null;
try { UnrarJs = require('node-unrar-js'); }
catch (_) { log('warn', '[archive] node-unrar-js not installed; RAR extraction disabled'); }

const SUBTITLE_EXTS = ['.srt', '.vtt', '.ass', '.ssa', '.sub', '.smi'];

function isZipBuffer(buf) {
    return buf && buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function isRarBuffer(buf) {
    return buf && buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21;
}

function isSubtitleEntry(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    if (lower.startsWith('._') || lower.startsWith('__macosx')) return false;
    return SUBTITLE_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * Extract subtitle entries from a ZIP/RAR/raw buffer.
 */
function extractSubtitleEntries(buffer) {
    if (isZipBuffer(buffer)) {
        if (!AdmZip) throw new Error('ZIP extraction not available (adm-zip missing)');
        const zip = new AdmZip(buffer);
        return zip.getEntries()
            .filter((e) => isSubtitleEntry(e.entryName))
            .map((e) => ({ name: e.entryName, getData: () => e.getData() }));
    }
    if (isRarBuffer(buffer)) {
        if (!UnrarJs) throw new Error('RAR extraction not available (node-unrar-js missing)');
        return extractRarEntries(buffer);
    }
    return [];
}

function extractRarEntries(buffer) {
    const out = [];
    return UnrarJs.createExtractorFromData({ data: buffer }).then((extractor) => {
        const list = extractor.getFileList();
        const headers = [...list.fileHeaders]
            .filter((h) => !h.flags.directory && isSubtitleEntry(h.name));
        for (const h of headers) {
            const extracted = extractor.extract({ files: [h.name] });
            const files = [...extracted.files];
            if (files.length > 0 && files[0].extraction) {
                out.push({ name: h.name, getData: () => Buffer.from(files[0].extraction) });
            }
        }
        return out;
    });
}

// How much a file of each track type is wanted, given what the entry claims to be. An entry
// labelled `· HI` must not be served the plain track, and nothing should be served commentary.
const TRACK_PREFERENCE = {
    plain:  { commentary: -100, forced: -50, hi:  -10, plain:  50, none: 10 },
    hi:     { commentary: -100, forced: -50, hi:  100, plain: -10, none:  0 },
    forced: { commentary: -100, forced: 100, hi:  -50, plain: -50, none:  0 }
};

/** Of the files matching the episode, the one closest to what the entry claims to be. */
function pickTrack(matches, track) {
    if (!matches || matches.length === 0) return null;
    const table = TRACK_PREFERENCE[track] || TRACK_PREFERENCE.plain;
    let best = null;
    let bestScore = -Infinity;
    for (const entry of matches) {
        const score = table[trackTypeOf(entry.name) || 'none'];
        if (score > bestScore) { best = entry; bestScore = score; }
    }
    return best;
}

/**
 * Pick the best subtitle entry for the given hints.
 *
 * Priority:
 *   1. season+episode pattern (S01E07)
 *   2. episode-only pattern (E07, x07, .07.)
 *   3. filename token overlap (>=3 shared tokens)
 *   4. first SRT, then first entry
 *
 * If `episode` is set and no candidate matches, returns null (caller should 404).
 */
function selectSubtitleEntry(entries, { season, episode, filename, langPatterns, track } = {}) {
    if (!entries || entries.length === 0) return null;
    if (entries.length === 1 && !episode) return entries[0];

    const epNum = episode != null ? String(episode).padStart(2, '0') : null;
    const seNum = season != null ? String(season).padStart(2, '0') : null;

    if (entries.length === 1) {
        return entries[0];
    }

    if (epNum) {
        if (seNum) {
            const exact = new RegExp(`[sS]0*${season}[eE]${epNum}(?!\\d)`, 'i');
            const hit = pickTrack(entries.filter((e) => exact.test(e.name)), track);
            if (hit) return hit;
        }

        const patterns = [
            new RegExp(`[sS]\\d+[eE]${epNum}(?!\\d)`, 'i'),
            new RegExp(`[eE]${epNum}(?!\\d)`, 'i'),
            new RegExp(`x${epNum}(?!\\d)`, 'i'),
            new RegExp(`\\.${epNum}\\.`),
            new RegExp(`-${epNum}-`),
            new RegExp(` ${epNum} `),
            new RegExp(`(?:^|[/\\\\])0*${parseInt(episode, 10)}(?![0-9a-zA-Z])`)
        ];
        const matched = entries.filter((entry) => {
            if (seNum) {
                const m = entry.name.match(/[sS](\d+)[eE]/i);
                if (m && parseInt(m[1], 10) !== parseInt(season, 10)) return false;
            }
            return patterns.some((p) => p.test(entry.name));
        });
        const hit = pickTrack(matched, track);
        if (hit) return hit;
    }

    if (filename) {
        const fnameTokens = String(filename).toLowerCase().split(/[\.\-_\s]+/);
        for (const entry of entries) {
            const entryTokens = entry.name.toLowerCase().split(/[\.\-_\s]+/);
            const overlap = fnameTokens.filter((t) => t && entryTokens.includes(t)).length;
            if (overlap >= 3) return entry;
        }
    }

    if (langPatterns && langPatterns.length > 0) {
        for (const entry of entries) {
            const lower = entry.name.toLowerCase();
            if (langPatterns.some((p) => lower.includes(p))) return entry;
        }
    }

    return entries.find((e) => e.name.toLowerCase().endsWith('.srt')) ||
           entries.find((e) => e.name.toLowerCase().endsWith('.ass') || e.name.toLowerCase().endsWith('.vtt')) ||
           entries[0];
}

function detectEntryFormat(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.ass') || lower.endsWith('.ssa')) return 'ass';
    if (lower.endsWith('.vtt')) return 'vtt';
    if (lower.endsWith('.sub') || lower.endsWith('.smi')) return 'sub';
    return 'srt';
}

/**
 * Convert subtitle text to the requested output format.
 */
function convertForOutput(content, requestedFormat) {
    if (content) {
        content = stripWyzieWatermark(content);
    }

    const original = isAssFormat(content) ? 'ass' : detectFromContent(content);

    if (requestedFormat === 'ass' || requestedFormat === 'ssa') {
        return { content, originalFormat: original, outputFormat: 'ass' };
    }

    if (original === 'ass') {
        if (requestedFormat === 'srt') {
            const r = convertToSrt(content);
            return { content: r.srt, originalFormat: 'ass', outputFormat: 'srt', captionCount: r.captionCount };
        }
        const r = convertSubtitle(content);
        return { content: r.content, originalFormat: 'ass', outputFormat: r.format, captionCount: r.captionCount };
    }

    return { content, originalFormat: original, outputFormat: original };
}

function detectFromContent(content) {
    if (!content) return 'srt';
    if (content.startsWith('WEBVTT')) return 'vtt';
    return 'srt';
}

function bufferToText(buffer) {
    return bufferToUtf8(buffer);
}

function contentTypeFor(format) {
    if (format === 'vtt') return 'text/vtt; charset=utf-8';
    if (format === 'ass' || format === 'ssa') return 'text/x-ssa; charset=utf-8';
    return 'text/plain; charset=utf-8';
}

/**
 * Known promotional/advertisement patterns injected by subtitle aggregators.
 */
const AD_PATTERNS = [
    // Wyzie free-plan upsell & branding
    /you'?re on the free plan/i,
    /store\.wyzie\.io/i,
    /wyzie\.io/i,
    // Ray subtitle watermark (getray.app, tryray.app, etc.)
    /getray\.app/i,
    /tryray\.app/i,
    /ray\.app/i,
    /\b[a-z0-9-]+\.app\b/i,
    /厌倦了搜索字幕/i,
    /即刻生成字幕/i,
    /立刻生成字幕/i,
];

/**
 * Remove promotional advertisement cues injected by aggregators (Wyzie, getray.app, etc.).
 *
 * Supports ASS, SSA, SRT, and VTT subtitle formats.
 *
 * @param {string} content - Raw subtitle text (ASS, SSA, SRT, or VTT)
 * @returns {string} - Subtitle text with ad cues removed
 */
function stripWyzieWatermark(content) {
    if (!content || typeof content !== 'string') return content;

    // Quick bail-out: skip processing if none of the known ad strings are present
    const lower = content.toLowerCase();
    if (!AD_PATTERNS.some(p => p.test(lower))) return content;

    // Check if ASS / SSA format
    if (isAssFormat(content) || content.includes('[Events]')) {
        return content.split(/\r?\n/).filter(line => {
            if (!line.startsWith('Dialogue:') && !line.startsWith('Comment:')) return true;
            return !AD_PATTERNS.some(p => p.test(line));
        }).join('\n');
    }

    // SRT or VTT format
    const isVtt = content.startsWith('WEBVTT');
    const normalised = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalised.split(/\n{2,}/);

    const filtered = blocks.filter((block) => {
        const trimmed = block.trim();
        if (!trimmed) return false;

        // Always keep the WEBVTT header block
        if (isVtt && trimmed.startsWith('WEBVTT')) return true;

        // Remove only if the text matches a known ad pattern
        return !AD_PATTERNS.some(p => p.test(trimmed));
    });

    const rejoined = filtered.join('\n\n');

    // Re-number SRT sequence indices so gaps don't confuse players
    if (!isVtt) {
        let idx = 1;
        return rejoined.replace(/^(\d+)(\n\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->)/gm,
            (_m, _n, rest) => `${idx++}${rest}`);
    }

    return rejoined;
}

module.exports = {
    isZipBuffer,
    isRarBuffer,
    isSubtitleEntry,
    extractSubtitleEntries,
    selectSubtitleEntry,
    detectEntryFormat,
    convertForOutput,
    bufferToText,
    contentTypeFor,
    stripWyzieWatermark,
    SUBTITLE_EXTS
};
