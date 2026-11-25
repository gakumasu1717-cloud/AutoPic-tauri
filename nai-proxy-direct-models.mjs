// Browser copy of autopic-nai-proxy/direct-models.mjs (2026-09-22) for TauriTavern, which cannot run ST server plugins.
// Only change: the Node Buffer reference check below uses atob/DataView.
// Model capabilities verified against NovelAI's public client on 2026-09-22.
// See README.md for documentation/client discrepancies and source URLs.
const samplers = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_sde', 'k_dpmpp_2m_sde'];
const common = {
    samplers,
    defaults: { width: 832, height: 1216, steps: 23, sampler: 'k_euler_ancestral', scheduler: 'karras', quality: 'standard', ucPreset: 'heavy' },
};
export const DIRECT_MODELS = {
    'nai-diffusion-4-5-full': {
        ...common, name: 'V4.5 Full', maxCharacters: 6, vibe: true, reference: true,
        transparency: false, variety: true, freePosition: false,
        schedulers: ['karras', 'exponential', 'polyexponential'], qualityPresets: ['standard', 'none'],
        defaults: { ...common.defaults, scale: 5 },
    },
    'nai-diffusion-5-full': {
        ...common, name: 'V5 Full', maxCharacters: 22, vibe: false, reference: false,
        transparency: true, variety: false, freePosition: true,
        schedulers: ['karras'], qualityPresets: ['standard', 'light', 'none'],
        defaults: { ...common.defaults, scale: 7 },
    },
};

const heavy = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
const furry = '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic';
export const UC_PRESETS = {
    'nai-diffusion-4-5-full': {
        heavy, light: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
        furryFocus: furry, humanFocus: `${heavy}, @_@, mismatched pupils, glowing eyes, bad anatomy`, none: '',
    },
    'nai-diffusion-5-full': {
        heavy, light: 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::',
        furryFocus: furry, humanFocus: `${heavy}, @_@, mismatched pupils, glowing eyes, bad anatomy`, none: '',
    },
};

export class DirectInputError extends Error {
    status = 400;
}
function number(value, fallback, min, max, name, integer = false) {
    const n = value ?? fallback;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
        throw new DirectInputError(`${name}: ${min}~${max}${integer ? ' 정수' : ''} 값을 입력해 주세요.`);
    }
    return n;
}
function choice(value, fallback, allowed, name) {
    const result = value ?? fallback;
    if (!allowed.includes(result)) throw new DirectInputError(`${name}: 지원하지 않는 값입니다.`);
    return result;
}
function prompt(value, name) {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > 60000) throw new DirectInputError(`${name}: 올바른 프롬프트가 아닙니다.`);
    return value.trim();
}
const join = (...parts) => parts.filter(Boolean).join(', ');

function center(item, index, total, profile) {
    const fallback = { x: total < 2 ? 0.5 : 0.1 + 0.8 * index / (total - 1), y: 0.5 };
    const source = item.center ?? item.centers?.[0] ?? fallback;
    const x = number(source.x, fallback.x, 0, 1, 'Character X');
    const y = number(source.y, fallback.y, 0, 1, 'Character Y');
    const grid = n => Math.min(0.9, Math.max(0.1, Math.round((n - 0.1) / 0.2) * 0.2 + 0.1));
    return profile.freePosition ? { x, y } : { x: grid(x), y: grid(y) };
}

/** Pure validation and payload construction; never imports ST or mutates saved settings. */
export function buildDirectRequest(body, randomSeed) {
    const profile = Object.hasOwn(DIRECT_MODELS, body?.model) ? DIRECT_MODELS[body.model] : undefined;
    if (!profile) throw new DirectInputError('AutoPic 직접 생성은 V4.5 Full / V5 Full만 지원합니다.');
    const d = profile.defaults;
    const width = number(body.width, d.width, 64, 2048, 'Width', true);
    const height = number(body.height, d.height, 64, 2048, 'Height', true);
    if (width % 64 || height % 64 || width * height > 4194304) throw new DirectInputError('해상도는 64의 배수, 최대 4,194,304 픽셀이어야 합니다.');
    const sampler = choice(body.sampler, d.sampler, profile.samplers, 'Sampler');
    const scheduler = choice(body.scheduler, d.scheduler, profile.schedulers, 'Noise schedule');
    const quality = choice(body.quality, d.quality, profile.qualityPresets, 'Quality tags');
    const ucPreset = choice(body.ucPreset, d.ucPreset, Object.keys(UC_PRESETS[body.model]), 'UC preset');
    const rawCharacters = body.characterPrompts ?? [];
    if (!Array.isArray(rawCharacters)) throw new DirectInputError('Character Prompts는 배열이어야 합니다.');
    const characters = rawCharacters.filter(c => c && c.enabled !== false && prompt(c.prompt, 'Character prompt'));
    if (characters.length > profile.maxCharacters) throw new DirectInputError(`${profile.name}: 캐릭터 프롬프트는 최대 ${profile.maxCharacters}개입니다.`);
    let base = prompt(body.prompt, 'Prompt');
    if (/<\/?(?:autopic|scene|apchar|uc)\b|&lt;\/?(?:autopic|scene|apchar|uc)\b/i.test(base)) throw new DirectInputError('AutoPic 구조 태그를 메인 프롬프트로 전송할 수 없습니다. 클라이언트를 업데이트해 주세요.');
    if (!base && !characters.length) throw new DirectInputError('생성할 프롬프트가 없습니다.');
    const dataset = choice(body.dataset, 'anime', ['anime', 'furry', 'background'], 'Dataset');
    if (dataset !== 'anime') base = join(dataset === 'furry' ? 'fur dataset' : 'background dataset', base);
    if (body.transparent && !profile.transparency) throw new DirectInputError('투명 배경은 V5에서만 지원합니다.');
    // Match the client's tag ordering without accidentally adding tags to rendered text.
    const suffix = join(body.transparent ? 'transparent background' : '', quality === 'none' ? '' : quality === 'light' ? 'very aesthetic, amazing quality, no text' : 'very aesthetic, masterpiece, no text');
    const textMarker = /(?:^|\s|[,.:[\]{}、。])text:(?!:)/i.exec(base);
    if (suffix) base = textMarker
        ? join(base.slice(0, textMarker.index), suffix) + base.slice(textMarker.index)
        : join(base, suffix);
    const negative = join(ucPreset !== 'none' && !base.toLowerCase().includes('nsfw') ? 'nsfw' : '', UC_PRESETS[body.model][ucPreset], prompt(body.negative_prompt, 'UC'));
    const useCoords = body.character_positions_ai_choice === false && (profile.freePosition ? characters.length > 0 : characters.length > 1);
    const centers = characters.map((c, i) => [center(c, i, characters.length, profile)]);
    const parameters = {
        params_version: 4, width, height,
        scale: number(body.scale, d.scale, 0, 10, 'Guidance'),
        steps: number(body.steps, d.steps, 1, 50, 'Steps', true),
        seed: number(body.seed, randomSeed, 0, 4294967295, 'Seed', true),
        sampler, noise_schedule: scheduler, n_samples: 1, image_format: 'png',
        cfg_rescale: number(body.cfg_rescale, 0, 0, 1, 'Guidance rescale'),
        negative_prompt: negative, qualityToggle: false, ucPreset: 3,
        tag_hint_qt: { none: 0, standard: 1, light: 3 }[quality],
        tag_hint_uc_preset: { none: 0, heavy: 2, light: 3, humanFocus: 4, furryFocus: 5 }[ucPreset],
        legacy: false, legacy_v3_extend: false, dynamic_thresholding: false,
        v4_prompt: { caption: { base_caption: base, char_captions: characters.map((c, i) => ({ char_caption: c.prompt.trim(), centers: centers[i] })) }, use_coords: useCoords, use_order: true },
        v4_negative_prompt: { caption: { base_caption: negative, char_captions: characters.map((c, i) => ({ char_caption: prompt(c.uc, 'Character UC'), centers: centers[i] })) }, legacy_uc: false },
    };
    if (sampler === 'k_euler_ancestral') {
        parameters.deliberate_euler_ancestral_bug = false;
        parameters.prefer_brownian = true;
    }
    if (body.variety && !profile.variety) throw new DirectInputError('V5는 Variety Boost를 지원하지 않습니다.');
    if (body.variety) parameters.skip_cfg_above_sigma = Math.sqrt(width * height / 1011712) * 58;
    if (profile.transparency) {
        parameters.straight_alpha = true;
        if (body.transparent) parameters.tag_hint_transparent_background = true;
    }
    const vibes = body.vibes ?? [];
    if (!Array.isArray(vibes) || vibes.length > 16) throw new DirectInputError('Vibe 이미지는 최대 16장입니다.');
    if (vibes.length && !profile.vibe) throw new DirectInputError('V5는 현재 Vibe Transfer를 지원하지 않습니다.');
    if (body.reference && !profile.reference) throw new DirectInputError('V5는 현재 Precise Reference를 지원하지 않습니다.');
    if (vibes.length && body.reference) throw new DirectInputError('Vibe Transfer와 Precise Reference는 동시에 사용할 수 없습니다.');
    const validatedVibes = vibes.map(v => ({
        image: image(v?.image), information: number(v?.information, 0.7, 0, 1, 'Information extracted'),
        strength: number(v?.strength, 0.6, 0, 1, 'Vibe strength'),
    }));
    if (body.reference) {
        const ref = body.reference;
        const referenceImage = image(ref.image);
        // Browser port (TauriTavern): only the first 24 bytes are needed for the PNG signature and IHDR size.
        let bytes;
        try { bytes = Uint8Array.from(atob(referenceImage.slice(0, 32)), c => c.charCodeAt(0)); } catch { bytes = new Uint8Array(0); }
        if (bytes.length < 24 || ![137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) throw new DirectInputError('Reference는 PNG 이미지여야 합니다.');
        const ihdr = new DataView(bytes.buffer);
        const size = `${ihdr.getUint32(16)}x${ihdr.getUint32(20)}`;
        if (!['1024x1536', '1536x1024', '1472x1472'].includes(size)) throw new DirectInputError('Reference 캔버스 크기가 올바르지 않습니다.');
        parameters.director_reference_images = [referenceImage];
        parameters.director_reference_descriptions = [{ caption: { base_caption: choice(ref.mode, 'character&style', ['character&style', 'character', 'style'], 'Reference mode'), char_captions: [] }, use_coords: false, use_order: false, legacy_uc: false }];
        parameters.director_reference_strength_values = [number(ref.strength, 1, 0, 1, 'Reference strength')];
        parameters.director_reference_secondary_strength_values = [1 - number(ref.fidelity, 1, 0, 1, 'Reference fidelity')];
        parameters.director_reference_information_extracted = [1];
    }
    return { request: { action: 'generate', model: body.model, input: base, parameters }, vibes: validatedVibes, normalizeVibes: body.normalizeVibes !== false };
}
function image(value) {
    if (typeof value !== 'string' || !value || value.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new DirectInputError('참조 이미지의 base64 데이터가 올바르지 않습니다.');
    return value;
}
