// Comic mode: one NovelAI image drawn as a comic page with several panels.
//
// The LLM writes an <autopic mode="comic"> block. This module turns it into a
// single NovelAI V4.5+ request built around three ideas:
//   1. Base caption = "comic" + shared setting tags + one short English prose
//      description of the page (layout, relative panel sizes, reading order,
//      per-panel camera). Panels are named by position, never by number.
//   2. Every appearance of a character in a panel is its own character caption
//      (appearance + that panel's framing/pose/expression + its speech bubble).
//   3. Each appearance gets coordinates inside its panel's region of the page,
//      so the model draws it in the right panel.
// When appearances exceed the model's character limit, the caller falls back to
// one merged caption per character (comic.actorPrompts).

export const COMIC_DEFAULTS = Object.freeze({
    enabled: false,
    frame: 'auto',        // auto | portrait | landscape
    dialogue: 'english',  // english | story | none
    maxPanels: 4,
});

const FRAMES = ['portrait', 'landscape'];
// top/bottom sit inside the outer thirds; on V4.5's 5x5 grid they snap to 0.1 / 0.9.
const ROWS = { top: 0.18, upper: 0.3, middle: 0.5, lower: 0.7, bottom: 0.82 };
const COLS = { left: 0.25, center: 0.5, right: 0.75 };
let optionsProvider = () => COMIC_DEFAULTS;

/** Lets the extension supply the saved comic settings without a circular import. */
export function setComicOptionsProvider(fn) {
    optionsProvider = typeof fn === 'function' ? fn : () => COMIC_DEFAULTS;
}

export function getComicOptions() {
    const raw = optionsProvider() || {};
    const maxPanels = Math.min(6, Math.max(2, Number.parseInt(raw.maxPanels, 10) || COMIC_DEFAULTS.maxPanels));
    return {
        enabled: !!raw.enabled,
        frame: ['auto', ...FRAMES].includes(raw.frame) ? raw.frame : COMIC_DEFAULTS.frame,
        dialogue: ['english', 'story', 'none'].includes(raw.dialogue) ? raw.dialogue : COMIC_DEFAULTS.dialogue,
        maxPanels,
    };
}

export function isComicContent(content) {
    return /<panel\b/i.test(String(content || ''));
}

function tagBlocks(source, tag) {
    return [...String(source || '').matchAll(new RegExp('<' + tag + '\\b([^>]*)>([\\s\\S]*?)<\\/' + tag + '>', 'gi'))]
        .map(m => ({ attrs: m[1] || '', content: m[2] || '' }));
}

function attr(attrs, name) {
    return new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(String(attrs || ''))?.[1] || '';
}

function cleanTags(value) {
    return String(value || '').replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
}

function join(parts) {
    return parts.map(cleanTags).filter(Boolean).join(', ');
}

/** Page prose: one line, no tags or numbered panel labels. */
function cleanProse(value) {
    return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Dialogue goes inside NovelAI's text: syntax; strip characters that would end the tag list. */
function cleanLine(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '').trim();
}

/** Parses pos="top-left" style positions; returns null when not understood. */
function parsePosition(value) {
    const words = String(value || '').toLowerCase().split(/[\s,_-]+/).filter(Boolean);
    if (!words.length) return null;
    let row, col;
    for (const word of words) {
        if (word in ROWS) row = ROWS[word];
        else if (word in COLS) col = COLS[word];
    }
    if (row === undefined && col === undefined) return null;
    return { x: col ?? 0.5, y: row ?? 0.5, wide: col === undefined || col === 0.5 };
}

/** Reading-order fallback when the model gave no position. */
function autoPosition(index, total, frame) {
    if (frame === 'landscape' && total <= 3) return { x: (index + 0.5) / total, y: 0.5, wide: false };
    if (total === 4) return { x: index % 2 ? 0.75 : 0.25, y: index < 2 ? 0.25 : 0.75, wide: false };
    return { x: 0.5, y: (index + 0.5) / total, wide: true };
}

function positionName(pos) {
    const row = pos.y < 0.4 ? 'top' : pos.y > 0.6 ? 'bottom' : 'middle';
    const col = pos.x < 0.4 ? 'left' : pos.x > 0.6 ? 'right' : '';
    return col ? `${row} ${col}` : row;
}

function clamp(n) {
    return Math.round(Math.min(0.9, Math.max(0.1, n)) * 100) / 100;
}

/**
 * Compiles the inside of a comic <autopic> block.
 * @param {string} inner block contents
 * @param {string} openAttrs attributes of the opening <autopic> tag
 * @param {{name:string,prompt:string,uc?:string,enabled?:boolean}[]} library registered characters
 * @param {(s:string)=>string} decode
 */
export function compileComic(inner, openAttrs = '', library = [], decode = value => value) {
    const options = getComicOptions();
    const outside = String(inner || '').replace(/<panel\b[^>]*>[\s\S]*?<\/panel>/gi, '');
    const panels = tagBlocks(inner, 'panel').slice(0, options.maxPanels);
    if (!panels.length) throw new Error('만화 블록에 <panel>이 없습니다.');

    const requested = decode(attr(openAttrs, 'frame')).trim().toLowerCase();
    const frame = options.frame !== 'auto' ? options.frame : (FRAMES.includes(requested) ? requested : 'portrait');

    const findRegistered = ref => {
        const key = String(ref || '').trim().toLowerCase();
        return key ? library.find(c => c && c.enabled !== false && String(c.name || '').trim().toLowerCase() === key) : undefined;
    };

    const occurrences = [];
    /** @type {Map<string, {name:string, appearance:string, uc:string, parts:string[], center:{x:number,y:number}}>} */
    const actors = new Map();
    const looseLines = [];
    const panelNotes = [];

    panels.forEach((panel, index) => {
        const pos = parsePosition(decode(attr(panel.attrs, 'pos') || attr(panel.attrs, 'position'))) || autoPosition(index, panels.length, frame);
        const where = positionName(pos);
        const shot = join(tagBlocks(panel.content, 'scene').map(b => decode(b.content)));
        const chars = tagBlocks(panel.content, 'apchar');
        const says = options.dialogue === 'none' ? [] : tagBlocks(panel.content, 'say')
            .map(b => ({ ref: decode(attr(b.attrs, 'ref') || attr(b.attrs, 'name')).trim().toLowerCase(), line: cleanLine(decode(b.content)) }))
            .filter(s => s.line);

        if (!chars.length) panelNotes.push(`${where} panel: ${shot || 'scenery'}`);

        // Spread several characters of one panel across its width.
        const spread = pos.wide ? 0.2 : 0.1;
        chars.forEach((block, i) => {
            const ref = decode(attr(block.attrs, 'ref') || attr(block.attrs, 'name')).trim();
            const registered = findRegistered(ref);
            const name = registered?.name || ref;
            const offset = chars.length > 1 ? (i / (chars.length - 1) - 0.5) * 2 * spread : 0;
            const center = { x: clamp(pos.x + offset), y: clamp(pos.y) };
            const action = cleanTags(decode(block.content));
            const lines = says.filter(s => s.ref && s.ref === name.toLowerCase()).map(s => `speech bubble, text:${s.line}`);
            says.forEach(s => { if (s.ref && s.ref === name.toLowerCase()) s.used = true; });

            occurrences.push({
                name,
                // Text stays last so NovelAI reads it as rendered text.
                prompt: join([registered?.prompt || '', `in the ${where} panel`, shot, action, ...lines]),
                uc: registered?.uc || '',
                enabled: true,
                center,
            });

            const key = registered ? `ref:${registered.name.toLowerCase()}` : (ref ? `name:${ref.toLowerCase()}` : `anon:${index}:${i}`);
            if (!actors.has(key)) actors.set(key, { name, appearance: registered?.prompt || '', uc: registered?.uc || '', parts: [], lines: [], center });
            const actor = actors.get(key);
            actor.parts.push(`${where} panel: ${join([shot, action])}`);
            actor.lines.push(...lines);
        });
        says.filter(s => !s.used).forEach(s => looseLines.push(`speech bubble, text:${s.line}`));
    });

    const hasDialogue = options.dialogue !== 'none' && (looseLines.length > 0 || occurrences.some(o => o.prompt.includes('text:')));
    const sharedScene = join(tagBlocks(outside, 'scene').map(b => decode(b.content)));
    const negative_prompt = join(tagBlocks(outside, 'uc').map(b => decode(b.content)));
    const page = cleanProse(decode(tagBlocks(outside, 'page').map(b => b.content).join(' ')));
    const pageProse = page || `a comic page with ${panels.length} panels in reading order`;

    const prompt = join([
        'comic',
        hasDialogue ? 'speech bubble' : 'no text',
        sharedScene,
        pageProse,
        ...panelNotes,
        ...looseLines,
    ]);

    const actorPrompts = [...actors.values()].map(a => ({
        name: a.name,
        prompt: join([a.appearance, ...a.parts, ...a.lines]),
        uc: a.uc,
        enabled: true,
        center: a.center,
    }));

    return {
        prompt,
        negative_prompt,
        characterPrompts: occurrences,
        comic: { frame, panels: panels.length, actorPrompts },
    };
}

/**
 * Picks per-panel captions when they fit the model's character limit,
 * otherwise one merged caption per character.
 */
export function fitComicCharacters(payload, maxCharacters = 6) {
    if (!payload?.comic) return payload;
    if (payload.characterPrompts.length <= maxCharacters) return payload;
    return { ...payload, characterPrompts: payload.comic.actorPrompts.slice(0, maxCharacters) };
}

/** Keeps the user's resolution but turns it to the requested page orientation. */
export function orientComicSize(width, height, frame) {
    const w = Number(width), h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        return frame === 'landscape' ? [1216, 832] : [832, 1216];
    }
    if (frame === 'landscape' && h > w) return [h, w];
    if (frame === 'portrait' && w > h) return [h, w];
    return [w, h];
}

/** Instruction block appended to AutoPic's prompt when comic mode is on. Never truncates user templates. */
export function buildComicPrompt(options = getComicOptions()) {
    if (!options.enabled) return '';
    const frameRule = options.frame === 'auto'
        ? '- Pick frame="portrait" for pages read top to bottom (talk, emotion, close moments) and frame="landscape" for wide action or scenery.'
        : `- Always use frame="${options.frame}".`;
    const dialogueRule = {
        english: '- <say ref="Name">: optional, at most one per panel, a short ENGLISH line of 1-6 words spoken by a character visible in that panel. Translate if the story is in another language; image models render English text most reliably.',
        story: '- <say ref="Name">: optional, at most one per panel, a short line of 1-6 words in the story\'s language, spoken by a character visible in that panel.',
        none: '- Do not write <say>; this comic has no dialogue.',
    }[options.dialogue];
    return `\n\n<autopic_comic_mode>
Comic mode is ON. This OVERRIDES the single-illustration format and examples given earlier for <autopic> blocks.
Every image is ONE comic page with 2-${options.maxPanels} panels, not a single illustration. A block without <page> and <panel> sections is wrong while comic mode is on.
Keep the story outside the block and append the block after the story, as usual. Use this structure:
<autopic mode="comic" frame="portrait">
<scene>tags shared by the whole page: location, time, lighting</scene>
<page>one short English sentence describing the page layout: how many panels, their relative sizes and positions, the reading order and what each panel's camera shows</page>
<panel pos="top">
<scene>this panel's framing tags, e.g. wide shot, close-up, upper body, from side</scene>
<apchar ref="Name">pose, expression and action in this panel</apchar>
<say ref="Name">Line</say>
</panel>
<panel pos="bottom left">...</panel>
<uc>optional</uc>
</autopic>
- pos is where the panel sits on the page: top, middle or bottom, optionally with left or right (e.g. "top", "middle right", "bottom left"). Panels must not share the same pos. List panels in reading order.
- In <page>, refer to panels only by position or shape (the wide top panel, the small inset on the right); never write panel numbers or labels. Keep it under ${40 + 40 * options.maxPanels} characters.
- Give each visible character its own <apchar> inside every panel it appears in, using the same ref each time. Make the panels different beats: setup, reaction, punchline or consequence, with varied framing.
${frameRule}
${dialogueRule}
- The tag rules above still apply to every <scene> and <apchar>, including inside panels.
</autopic_comic_mode>`;
}
