// Comic mode: one NovelAI image drawn as a comic page with several panels.
//
// The LLM writes an <autopic mode="comic"> block with <panel> sections. This
// module turns it into a single NovelAI request:
//   - base caption: comic page tags, shared setting, then each panel's shot
//   - one character caption per character, gathering that character's
//     per-panel actions and speech-bubble lines (V4.5+ text rendering)
// The block's frame attribute (portrait / landscape) picks the page orientation.

export const COMIC_DEFAULTS = Object.freeze({
    enabled: false,
    frame: 'auto',        // auto | portrait | landscape
    dialogue: 'english',  // english | story | none
    maxPanels: 4,
});

const FRAMES = ['portrait', 'landscape'];
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

/** Dialogue goes inside NovelAI's text: syntax; strip characters that would end the tag list. */
function cleanLine(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '').trim();
}

/**
 * Compiles the inside of a comic <autopic> block.
 * @param {string} inner block contents
 * @param {string} openAttrs attributes of the opening <autopic> tag
 * @param {{name:string,prompt:string,uc?:string,center?:{x:number,y:number},enabled?:boolean}[]} library registered characters
 * @param {(s:string)=>string} decode
 */
export function compileComic(inner, openAttrs = '', library = [], decode = value => value) {
    const options = getComicOptions();
    const withoutPanels = String(inner || '').replace(/<panel\b[^>]*>[\s\S]*?<\/panel>/gi, '');
    const panels = tagBlocks(inner, 'panel').slice(0, options.maxPanels);
    if (!panels.length) throw new Error('만화 블록에 <panel>이 없습니다.');

    const requested = decode(attr(openAttrs, 'frame')).trim().toLowerCase();
    const frame = options.frame !== 'auto' ? options.frame : (FRAMES.includes(requested) ? requested : 'portrait');

    const findRegistered = ref => {
        const key = String(ref || '').trim().toLowerCase();
        return key ? library.find(c => c && c.enabled !== false && String(c.name || '').trim().toLowerCase() === key) : undefined;
    };

    /** @type {Map<string, {name:string, appearance:string, uc:string, center?:object, actions:string[], lines:string[]}>} */
    const cast = new Map();
    const member = (ref, fallbackKey) => {
        const registered = findRegistered(ref);
        const key = registered ? `ref:${registered.name.toLowerCase()}` : (ref ? `name:${ref.trim().toLowerCase()}` : fallbackKey);
        if (!cast.has(key)) {
            cast.set(key, {
                name: registered?.name || ref || '',
                appearance: registered?.prompt || '',
                uc: registered?.uc || '',
                ...(registered?.center ? { center: { ...registered.center } } : {}),
                actions: [],
                lines: [],
            });
        }
        return cast.get(key);
    };

    const panelShots = [];
    let hasDialogue = false;
    panels.forEach((panel, index) => {
        const number = index + 1;
        const shot = join(tagBlocks(panel.content, 'scene').map(b => decode(b.content)));
        panelShots.push(`panel ${number}: ${shot || 'scene'}`);

        tagBlocks(panel.content, 'apchar').forEach((block, i) => {
            const ref = decode(attr(block.attrs, 'ref') || attr(block.attrs, 'name'));
            const who = member(ref, `panel${number}:${i}`);
            const action = cleanTags(decode(block.content));
            if (action) who.actions.push(`panel ${number}: ${action}`);
        });

        if (options.dialogue !== 'none') {
            tagBlocks(panel.content, 'say').forEach(block => {
                const line = cleanLine(decode(block.content));
                if (!line) return;
                const ref = decode(attr(block.attrs, 'ref') || attr(block.attrs, 'name'));
                member(ref, `say${number}`).lines.push(`panel ${number}: speech bubble, text:${line}`);
                hasDialogue = true;
            });
        }
    });

    const sharedScene = join(tagBlocks(withoutPanels, 'scene').map(b => decode(b.content)));
    const negative_prompt = join(tagBlocks(withoutPanels, 'uc').map(b => decode(b.content)));
    const prompt = join([
        'comic',
        `${panels.length} panels`,
        'panel border',
        hasDialogue ? 'speech bubble' : 'no text',
        sharedScene,
        ...panelShots,
    ]);

    const characterPrompts = [...cast.values()]
        .map(c => ({
            name: c.name,
            // Text goes last so NovelAI reads it as the rendered text.
            prompt: join([c.appearance, ...c.actions, ...c.lines]),
            uc: c.uc,
            enabled: true,
            ...(c.center ? { center: c.center } : {}),
        }))
        .filter(c => c.prompt);

    return { prompt, negative_prompt, characterPrompts, comic: { frame, panels: panels.length } };
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
        ? '- Set frame="portrait" for close, emotional or vertical pages and frame="landscape" for wide action or scenery.'
        : `- Always use frame="${options.frame}".`;
    const dialogueRule = {
        english: '- Dialogue: at most one <say ref="..."> per panel, a short ENGLISH line of 1-6 words (translate if the story is not in English). Image models render English text most reliably.',
        story: '- Dialogue: at most one <say ref="..."> per panel, a short line of 1-6 words in the story\'s language.',
        none: '- Do not write <say> blocks; this comic has no dialogue.',
    }[options.dialogue];
    return `\n\n<autopic_comic_mode>
Comic mode is ON. Draw every image as ONE comic page with 2-${options.maxPanels} panels instead of a single illustration.
Use this structure inside the usual <autopic> block:
<autopic mode="comic" frame="portrait">
<scene>shared setting tags for the whole page: location, time, lighting</scene>
<panel>
<scene>this panel's shot and composition tags</scene>
<apchar ref="Name">this panel's pose, expression and action tags</apchar>
<say ref="Name">Line</say>
</panel>
<panel>...</panel>
<uc>optional</uc>
</autopic>
- Panels go in reading order. Each panel is a different beat of the moment: setup, reaction, punchline or consequence.
- Inside each panel, give every visible character its own <apchar>. Use the same ref for the same character in every panel. The page-level <scene> holds only what all panels share.
- Shot tags such as close-up, upper body, full body, from side or from above make the panels read differently.
${frameRule}
${dialogueRule}
- The tag rules above still apply to every <scene> and <apchar>, inside panels too.
</autopic_comic_mode>`;
}
