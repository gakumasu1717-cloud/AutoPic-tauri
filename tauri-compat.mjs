// TauriTavern compatibility layer for AutoPic.
//
// TauriTavern replaces the SillyTavern Node server with an in-app router. That
// router cannot run ST server plugins and has no handler for
// POST /api/novelai/generate-image, so inside TauriTavern:
//   - the built-in Image Generation extension (NovelAI source) gets
//     "404 Unsupported endpoint", and
//   - the AutoPic server plugin routes (/api/plugins/autopic/*) do not exist.
//
// This module is a no-op outside TauriTavern. Inside it, it answers those
// requests from the page by calling NovelAI directly (NovelAI sends
// Access-Control-Allow-Origin: *). The plugin routes are a browser port of
// autopic-nai-proxy (index.mjs / direct-route.mjs, 2026-09-22); the ST route
// mirrors src/endpoints/novelai.js.
//
// It also surfaces the real error text when a character save / avatar change
// fails, because SillyTavern only shows a generic "invalid format" toast.

import { getRequestHeaders } from '../../../../script.js';
import { DIRECT_MODELS, buildDirectRequest, DirectInputError } from './nai-proxy-direct-models.mjs';

const NOVEL_IMAGE_PATH = '/api/novelai/generate-image';
const PLUGIN_PREFIX = '/api/plugins/autopic/';
const CHARACTER_SAVE_PATHS = new Set([
    '/api/characters/edit',
    '/api/characters/edit-avatar',
    '/api/characters/create',
]);
const IMAGE_NOVELAI = 'https://image.novelai.net';
const API_NOVELAI = 'https://api.novelai.net';
const REFERENCE_PIXEL_COUNT = 1011712; // 832 * 1216
const SIGMA_MAGIC_NUMBER = 19;
const SIGMA_MAGIC_NUMBER_V4_5 = 58;
const MAX_FAVORITES = 4;
const NAI_GENERATION_LOCK_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000];
const LOCAL_KEY_STORAGE = 'autopic_tauri_novelai_key';

let baseFetch = null;       // fetch underneath this layer (TauriTavern's patched fetch)
let layerFetch = null;      // this layer
let topFetch = null;        // AutoPic's NAI interceptor (outermost when installed)
let guardFetch = null;      // re-installed guard when the host re-patches fetch on top

// Session-only replacements for the plugin's vibe cache (it persisted favorites to disk).
const vibeCache = new Map();
const vibeCacheMeta = new Map();
let favoriteVibes = new Set();
const activeDirectAccounts = new Set();

export function isTauriTavern() {
    return Boolean(globalThis.__TAURITAVERN_HOST__);
}

export function getLocalNovelKey() {
    try {
        return localStorage.getItem(LOCAL_KEY_STORAGE) || '';
    } catch {
        return '';
    }
}

export function setLocalNovelKey(value) {
    try {
        const trimmed = String(value || '').trim();
        if (trimmed) localStorage.setItem(LOCAL_KEY_STORAGE, trimmed);
        else localStorage.removeItem(LOCAL_KEY_STORAGE);
    } catch {
        // Storage unavailable: the key is simply not remembered.
    }
}

/** Installs the compatibility layer. Must run before AutoPic installs its NAI interceptor. */
export function installTauriCompat() {
    if (!isTauriTavern() || layerFetch) return;
    baseFetch = window.fetch.bind(window);
    layerFetch = async function autopicTauriLayer(input, init = {}) {
        const path = getSameOriginPath(input);
        const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

        if (path && path.startsWith(PLUGIN_PREFIX)) {
            return handlePluginRoute(path.slice(PLUGIN_PREFIX.length), method, init);
        }

        if (path === NOVEL_IMAGE_PATH && method === 'POST') {
            const hostResponse = await baseFetch(input, init);
            if (!(await isUnsupportedEndpoint(hostResponse))) return hostResponse;
            return handleStGenerateImage(parseBody(init), init?.signal);
        }

        if (path && CHARACTER_SAVE_PATHS.has(path) && method === 'POST') {
            const response = await baseFetch(input, init);
            if (!response.ok) reportCharacterSaveError(path, response);
            return response;
        }

        return baseFetch(input, init);
    };
    window.fetch = layerFetch;
}

/** Remembers AutoPic's NAI interceptor so NovelAI requests can be routed back to it. */
export function registerTopFetch(fn) {
    if (!isTauriTavern()) return;
    topFetch = fn;
}

/**
 * TauriTavern may re-apply its own fetch patch on top of extensions. If that
 * happened, NovelAI image requests would be answered by the host before
 * AutoPic's interceptor sees them, so route them back to the interceptor.
 */
export function ensureTauriCompat() {
    if (!isTauriTavern() || !layerFetch) return;
    const current = window.fetch;
    if (current === topFetch || current === layerFetch || current === guardFetch) return;

    const outer = current.bind(window);
    const target = topFetch || layerFetch;
    guardFetch = async function autopicTauriGuard(input, init = {}) {
        if (getSameOriginPath(input) === NOVEL_IMAGE_PATH) return target(input, init);
        return outer(input, init);
    };
    window.fetch = guardFetch;
}

async function handlePluginRoute(route, method, init) {
    const body = parseBody(init);
    switch (route) {
        case 'direct-models':
            return Response.json({ version: 1, models: DIRECT_MODELS });
        case 'generate-direct':
            return handleGenerateDirect(body, init?.signal);
        case 'generate-image':
            return handlePluginGenerateImage(body, init?.signal);
        case 'favorite-vibe':
            return favoriteVibe(body);
        case 'sync-favorites':
            return syncFavorites(body);
        case 'unfavorite-vibe':
            return unfavoriteVibe(body);
        default:
            return Response.json({ message: `TauriTavern에서 지원하지 않는 AutoPic 플러그인 경로: ${method} ${route}` }, { status: 404 });
    }
}

// ── shared helpers ───────────────────────────────────────────────────────────

function parseBody(init) {
    try {
        return typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    } catch {
        return {};
    }
}

function getSameOriginPath(input) {
    try {
        const raw = input instanceof Request ? input.url : String(input);
        const url = new URL(raw, window.location.href);
        return url.origin === window.location.origin ? url.pathname : null;
    } catch {
        return null;
    }
}

async function isUnsupportedEndpoint(response) {
    if (response.status !== 404) return false;
    try {
        return (await response.clone().text()).includes('Unsupported endpoint');
    } catch {
        return false;
    }
}

async function reportCharacterSaveError(path, response) {
    let detail = '';
    try {
        detail = (await response.clone().text()).trim();
    } catch {
        // ignore
    }
    if (!detail) detail = `HTTP ${response.status}`;
    if (detail.length > 400) detail = detail.slice(0, 400) + '…';
    console.error('[AutoPic] TauriTavern character save failed', { path, status: response.status, detail });
    toastr.error(`실제 오류: ${detail}`, `캐릭터 저장 실패 (${path})`, { timeOut: 15000 });
}

/** Reads the NovelAI key like readSecret() on the server; returns '' when unavailable. */
async function readNovelKey() {
    try {
        const response = await baseFetch('/api/secrets/find', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key: 'api_key_novel' }),
        });
        if (response.ok) {
            const data = await response.json();
            if (data?.value) return String(data.value);
        }
    } catch {
        // Fall through to the locally entered key.
    }
    return getLocalNovelKey();
}

const MISSING_KEY_MESSAGE = 'NovelAI 키를 읽을 수 없습니다. TauriTavern 설정에서 "Allow Keys Exposure"를 켜고 앱을 재시작하거나, AutoPic NAI 설정의 "TauriTavern용 NovelAI 키" 칸에 키를 넣어주세요.';

function textResponse(text, status, headers = {}) {
    return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text ?? '')));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomUint32() {
    return crypto.getRandomValues(new Uint32Array(1))[0];
}

function calculateSkipCfgAboveSigma(width, height, modelName) {
    const magic = modelName?.includes('nai-diffusion-4-5') ? SIGMA_MAGIC_NUMBER_V4_5 : SIGMA_MAGIC_NUMBER;
    return Math.pow((width * height) / REFERENCE_PIXEL_COUNT, 0.5) * magic;
}

async function upscaleOrOriginal(body, key, originalBase64, signal) {
    if (isNaN(body.upscale_ratio) || body.upscale_ratio <= 1) return originalBase64;
    try {
        const upscale = await baseFetch(`${API_NOVELAI}/ai/upscale`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: originalBase64, height: body.height, width: body.width, scale: body.upscale_ratio }),
            signal,
        });
        if (!upscale.ok) throw new Error(await upscale.text());
        const upscaled = await extractFileFromZip(new Uint8Array(await upscale.arrayBuffer()), '.png');
        if (!upscaled) throw new Error('Upscaled PNG was not found in the NAI zip response.');
        return bytesToBase64(upscaled);
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.warn('[AutoPic] Upscale failed. Returning original image:', error);
        return originalBase64;
    }
}

// ── ST route: /api/novelai/generate-image (src/endpoints/novelai.js) ─────────

async function handleStGenerateImage(body, signal) {
    try {
        const key = await readNovelKey();
        if (!key) return textResponse(MISSING_KEY_MESSAGE, 400);

        const width = body.width ?? 512;
        const height = body.height ?? 512;
        const model = body.model ?? 'nai-diffusion';
        const result = await baseFetch(`${IMAGE_NOVELAI}/ai/generate-image`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
                action: 'generate',
                input: body.prompt ?? '',
                model,
                parameters: {
                    params_version: 3,
                    prefer_brownian: true,
                    negative_prompt: body.negative_prompt ?? '',
                    height,
                    width,
                    scale: body.scale ?? 9,
                    seed: body.seed >= 0 ? body.seed : Math.floor(Math.random() * 9999999999),
                    sampler: body.sampler ?? 'k_dpmpp_2m',
                    noise_schedule: body.scheduler ?? 'karras',
                    steps: body.steps ?? 28,
                    n_samples: 1,
                    ucPreset: 0,
                    qualityToggle: false,
                    add_original_image: false,
                    controlnet_strength: 1,
                    deliberate_euler_ancestral_bug: false,
                    dynamic_thresholding: body.decrisper ?? false,
                    legacy: false,
                    legacy_v3_extend: false,
                    sm: body.sm ?? false,
                    sm_dyn: body.sm_dyn ?? false,
                    uncond_scale: 1,
                    skip_cfg_above_sigma: body.variety_boost ? calculateSkipCfgAboveSigma(width, height, model) : null,
                    use_coords: false,
                    characterPrompts: [],
                    reference_image_multiple: [],
                    reference_information_extracted_multiple: [],
                    reference_strength_multiple: [],
                    v4_negative_prompt: { caption: { base_caption: body.negative_prompt ?? '', char_captions: [] } },
                    v4_prompt: { caption: { base_caption: body.prompt ?? '', char_captions: [] }, use_coords: false, use_order: true },
                },
            }),
        });

        if (!result.ok) {
            const text = await result.text().catch(() => '');
            return textResponse(text || `NovelAI 오류 (${result.status})`, result.status);
        }
        const png = await extractFileFromZip(new Uint8Array(await result.arrayBuffer()), '.png');
        if (!png) return textResponse('NovelAI generated an image, but the PNG file was not found.', 500);
        return textResponse(await upscaleOrOriginal(body, key, await bytesToBase64(png), signal), 200);
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.error('[AutoPic] Direct NovelAI generation failed', error);
        return textResponse(String(error?.message || error), 500);
    }
}

// ── plugin: vibe cache and favorites (index.mjs) ─────────────────────────────

async function encodeVibe(imageB64, model, key, options = {}) {
    const identity = options.direct
        ? `direct-v1|${await sha256Hex(key)}|${options.information}|${model}|${imageB64}`
        : `${model}|${imageB64}`;
    const cacheKey = await sha256Hex(identity);
    if (vibeCache.has(cacheKey)) return vibeCache.get(cacheKey);

    const res = await baseFetch(`${IMAGE_NOVELAI}/ai/encode-vibe`, {
        method: 'POST',
        signal: options.signal,
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            image: imageB64,
            model,
            ...(options.direct ? { information_extracted: options.information } : { informationExtracted: 1.0 }),
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`encode-vibe ${res.status} ${res.statusText}: ${text}`);
    }

    const encoded = await bytesToBase64(new Uint8Array(await res.arrayBuffer()));
    vibeCache.set(cacheKey, encoded);
    vibeCacheMeta.set(cacheKey, await sha256Hex(imageB64));
    if (vibeCache.size > 64) {
        for (const cachedKey of vibeCache.keys()) {
            if (!favoriteVibes.has(vibeCacheMeta.get(cachedKey))) {
                vibeCache.delete(cachedKey);
                vibeCacheMeta.delete(cachedKey);
                if (vibeCache.size <= 64) break;
            }
        }
    }
    return encoded;
}

async function favoriteVibe(body) {
    const image = body?.image;
    if (typeof image !== 'string' || !image) return Response.json({ ok: false, message: 'image(base64) is required.' }, { status: 400 });
    const favId = await sha256Hex(image);
    if (!favoriteVibes.has(favId) && favoriteVibes.size >= MAX_FAVORITES) {
        return Response.json({ ok: false, message: `Favorites are limited to ${MAX_FAVORITES} images.`, count: favoriteVibes.size }, { status: 409 });
    }
    favoriteVibes.add(favId);
    return Response.json({ ok: true, favorite: true, count: favoriteVibes.size });
}

async function syncFavorites(body) {
    const images = Array.isArray(body?.images) ? body.images : [];
    const ids = await Promise.all(images.filter(s => typeof s === 'string' && s).map(sha256Hex));
    const newFavs = new Set(ids);
    if (newFavs.size > MAX_FAVORITES) {
        return Response.json({ ok: false, message: `Favorites are limited to ${MAX_FAVORITES} images.`, count: favoriteVibes.size }, { status: 409 });
    }
    favoriteVibes = newFavs;
    return Response.json({ ok: true, count: favoriteVibes.size });
}

async function unfavoriteVibe(body) {
    const image = body?.image;
    if (typeof image !== 'string' || !image) return Response.json({ ok: false, message: 'image(base64) is required.' }, { status: 400 });
    favoriteVibes.delete(await sha256Hex(image));
    return Response.json({ ok: true, favorite: false, count: favoriteVibes.size });
}

// ── plugin: prompt splitting (index.mjs) ─────────────────────────────────────

function isV4Model(model) {
    return typeof model === 'string' && model.includes('nai-diffusion-4');
}

function isConcurrentGenerationLock(status, text) {
    return status === 429 && String(text ?? '').includes('Concurrent generation is locked');
}

async function fetchNovelAiGenerateWithRetry(url, options) {
    for (let attempt = 0; attempt <= NAI_GENERATION_LOCK_RETRY_DELAYS_MS.length; attempt++) {
        const result = await baseFetch(url, options);
        if (result.ok) return { result, errorText: '' };
        const errorText = await result.text();
        const shouldRetry = isConcurrentGenerationLock(result.status, errorText)
            && attempt < NAI_GENERATION_LOCK_RETRY_DELAYS_MS.length;
        if (!shouldRetry) return { result, errorText };
        await sleep(NAI_GENERATION_LOCK_RETRY_DELAYS_MS[attempt]);
    }
    throw new Error('Unexpected NAI retry loop exit.');
}

function normalizeCenter(center, index = 0, total = 1) {
    if (center && typeof center === 'object') {
        const x = Number(center.x);
        const y = Number(center.y);
        if (!Number.isNaN(x) && !Number.isNaN(y)) {
            return { x: Math.min(0.9, Math.max(0.1, x)), y: Math.min(0.9, Math.max(0.1, y)) };
        }
    }
    if (total <= 1) return { x: 0.5, y: 0.5 };
    const spread = Math.min(0.8, 0.22 * (total - 1));
    const start = 0.5 - spread / 2;
    const step = spread / Math.max(1, total - 1);
    return { x: Math.min(0.9, Math.max(0.1, start + step * index)), y: 0.5 };
}

function normalizeCharacterPrompt(item, index, total) {
    if (typeof item === 'string') {
        return { prompt: item.trim(), uc: '', center: normalizeCenter(null, index, total), enabled: true };
    }
    return {
        prompt: String(item?.prompt ?? item?.char_caption ?? '').trim(),
        uc: String(item?.uc ?? item?.negative_prompt ?? item?.negative ?? '').trim(),
        center: normalizeCenter(item?.center ?? item?.centers?.[0], index, total),
        enabled: item?.enabled !== false,
    };
}

function cleanPromptPart(value) {
    return String(value ?? '').replace(/^[\s,;|]+/g, '').replace(/[\s,;|]+$/g, '').trim();
}

function normalizePromptForCompare(value) {
    return cleanPromptPart(value).replace(/\s+/g, ' ').toLowerCase();
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeCharacterPromptsFromBasePrompt(basePrompt, characters) {
    let result = String(basePrompt ?? '');
    for (const character of characters) {
        const prompt = cleanPromptPart(character?.prompt);
        if (!prompt) continue;
        result = result.replace(new RegExp(`(?:^|[\\s,;|]+)${escapeRegExp(prompt)}(?:[\\s,;|]+|$)`, 'gi'), ', ');
    }
    return cleanPromptPart(result.replace(/\s*,\s*,+/g, ','));
}

function mergeCharacterPromptLists(primaryCharacters, extraCharacters) {
    const merged = [];
    const seen = new Set();
    for (const character of [...primaryCharacters, ...extraCharacters]) {
        const prompt = cleanPromptPart(character?.prompt);
        const key = normalizePromptForCompare(prompt);
        if (!prompt || seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...character, prompt });
    }
    return merged.map((item, index, array) => ({ ...item, center: item.center ?? normalizeCenter(null, index, array.length) }));
}

function findCharacterMarkers(prompt) {
    const markers = [];
    for (const match of prompt.matchAll(/(?:Character|Char)\s*(\d+)\s*:/gi)) {
        markers.push({ index: match.index, end: match.index + match[0].length, number: Number(match[1]) });
    }
    return markers;
}

function splitPromptIntoBaseAndCharacters(prompt, explicitCharacters = []) {
    const rawPrompt = String(prompt ?? '').trim();
    const explicit = Array.isArray(explicitCharacters)
        ? explicitCharacters.map((item, index, array) => normalizeCharacterPrompt(item, index, array.length)).filter(item => item.enabled && item.prompt)
        : [];

    const markers = findCharacterMarkers(rawPrompt);
    if (markers.length > 0) {
        const basePrompt = removeCharacterPromptsFromBasePrompt(cleanPromptPart(rawPrompt.slice(0, markers[0].index)), explicit);
        const characters = [];
        for (let i = 0; i < markers.length; i++) {
            const end = i + 1 < markers.length ? markers[i + 1].index : rawPrompt.length;
            const promptPart = cleanPromptPart(rawPrompt.slice(markers[i].end, end));
            if (promptPart) characters.push(normalizeCharacterPrompt(promptPart, i, markers.length));
        }
        return { basePrompt, characters: mergeCharacterPromptLists(characters, explicit) };
    }

    if (rawPrompt.includes('|')) {
        const parts = rawPrompt.split('|').map(part => cleanPromptPart(part)).filter(Boolean);
        if (parts.length > 1) {
            const characterParts = parts.slice(1);
            return {
                basePrompt: removeCharacterPromptsFromBasePrompt(parts[0], explicit),
                characters: mergeCharacterPromptLists(
                    characterParts.map((part, index) => normalizeCharacterPrompt(part, index, characterParts.length)),
                    explicit,
                ),
            };
        }
    }

    return {
        basePrompt: removeCharacterPromptsFromBasePrompt(rawPrompt, explicit),
        characters: mergeCharacterPromptLists([], explicit),
    };
}

function buildNovelAiPromptPayload(body) {
    const explicitCharacters = body.characterPrompts ?? body.character_prompts ?? body.characters ?? [];
    const { basePrompt, characters } = splitPromptIntoBaseAndCharacters(body.prompt, explicitCharacters);
    const enabledCharacters = characters.filter(item => item.enabled && item.prompt);
    return {
        basePrompt,
        characterPrompts: enabledCharacters.map(item => ({ prompt: item.prompt, uc: item.uc || '', center: item.center, enabled: true })),
        v4Prompt: {
            caption: {
                base_caption: basePrompt,
                char_captions: enabledCharacters.map(item => ({ char_caption: item.prompt, centers: [item.center] })),
            },
            use_coords: enabledCharacters.length > 0,
            use_order: true,
        },
        v4NegativePrompt: {
            caption: {
                base_caption: body.negative_prompt ?? '',
                char_captions: enabledCharacters.map(item => ({ char_caption: item.uc || '', centers: [item.center] })),
            },
            legacy_uc: false,
        },
    };
}

// ── plugin: POST /generate-image (index.mjs) ─────────────────────────────────

async function handlePluginGenerateImage(body, signal) {
    const key = await readNovelKey();
    if (!key) return textResponse(MISSING_KEY_MESSAGE, 400);

    try {
        const cfgRescale = typeof body.cfg_rescale === 'number' ? body.cfg_rescale : 0;
        const model = body.model ?? 'nai-diffusion';
        const seed = body.seed >= 0 ? body.seed : Math.floor(Math.random() * 9999999999);
        const headers = { 'X-AutoPic-Seed': String(seed) };
        const naiPromptPayload = buildNovelAiPromptPayload(body);

        const referenceImage = typeof body.reference_image === 'string' && body.reference_image ? body.reference_image : null;
        const dirRefStrength = typeof body.reference_strength === 'number' ? body.reference_strength : 1.0;
        const refFidelity = typeof body.reference_fidelity === 'number' ? body.reference_fidelity : 1.0;
        const refModeRaw = typeof body.reference_mode === 'string' ? body.reference_mode : 'character&style';
        const refMode = ['character&style', 'character', 'style'].includes(refModeRaw) ? refModeRaw : 'character&style';

        const rawRefImages = Array.isArray(body.reference_image_multiple) ? body.reference_image_multiple : [];
        const rawRefInfo = Array.isArray(body.reference_information_extracted_multiple) ? body.reference_information_extracted_multiple : [];
        const rawRefStrength = Array.isArray(body.reference_strength_multiple) ? body.reference_strength_multiple : [];

        let refImages = rawRefImages;
        let refInfo = rawRefInfo;
        let refStrength = rawRefStrength;

        if (rawRefImages.length > 0 && isV4Model(model)) {
            const encoded = [];
            const encInfo = [];
            const encStrength = [];
            const encodeFailures = [];
            for (let i = 0; i < rawRefImages.length; i++) {
                const infoVal = typeof rawRefInfo[i] === 'number' ? rawRefInfo[i] : 1.0;
                const strength = typeof rawRefStrength[i] === 'number' ? rawRefStrength[i] : 0.6;
                try {
                    encoded.push(await encodeVibe(rawRefImages[i], model, key, { signal }));
                    encInfo.push(infoVal);
                    encStrength.push(strength);
                } catch (err) {
                    if (err?.name === 'AbortError') throw err;
                    console.warn(`[AutoPic] Failed to encode vibe image #${i + 1}; skipping it:`, err?.message || err);
                    encodeFailures.push(i + 1);
                }
            }
            if (encoded.length === 0) {
                return Response.json({
                    ok: false,
                    code: 'AUTOPIC_VIBE_ENCODE_FAILED',
                    message: 'Vibe Transfer 이미지 인코딩에 실패해서 생성을 중단했습니다. Vibe 이미지를 확인하거나 Vibe Transfer를 끄고 다시 시도해주세요.',
                    failedIndexes: encodeFailures,
                }, { status: 502 });
            }
            if (encodeFailures.length > 0) {
                // The server sent this as X-AutoPic-Vibe-Warning; Korean text is not a valid header value in a browser Response.
                toastr.warning(`일부 Vibe 이미지 인코딩에 실패해서 건너뛰었습니다: #${encodeFailures.join(', #')}`, 'AutoPic Vibe Transfer');
            }
            refImages = encoded;
            refInfo = encInfo;
            refStrength = encStrength;
        }

        const directorReferenceParams = referenceImage ? {
            director_reference_images: [referenceImage],
            director_reference_descriptions: [{
                use_coords: false,
                use_order: false,
                legacy_uc: false,
                caption: { base_caption: refMode, char_captions: [] },
            }],
            director_reference_strength_values: [dirRefStrength],
            director_reference_secondary_strength_values: [Math.max(0, Math.min(1, 1.0 - refFidelity))],
            director_reference_information_extracted: [1.0],
        } : {};

        const { result: generateResult, errorText } = await fetchNovelAiGenerateWithRetry(`${IMAGE_NOVELAI}/ai/generate-image`, {
            method: 'POST',
            signal,
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'generate',
                input: naiPromptPayload.basePrompt,
                model,
                parameters: {
                    params_version: 3,
                    prefer_brownian: true,
                    negative_prompt: body.negative_prompt ?? '',
                    height: body.height ?? 512,
                    width: body.width ?? 512,
                    scale: body.scale ?? 9,
                    cfg_rescale: cfgRescale,
                    seed,
                    sampler: body.sampler ?? 'k_dpmpp_2m',
                    noise_schedule: body.scheduler ?? 'karras',
                    steps: body.steps ?? 28,
                    n_samples: 1,
                    ucPreset: 0,
                    qualityToggle: false,
                    add_original_image: false,
                    controlnet_strength: 1,
                    deliberate_euler_ancestral_bug: false,
                    dynamic_thresholding: body.decrisper ?? false,
                    legacy: false,
                    legacy_v3_extend: false,
                    sm: body.sm ?? false,
                    sm_dyn: body.sm_dyn ?? false,
                    uncond_scale: 1,
                    skip_cfg_above_sigma: body.variety_boost
                        ? calculateSkipCfgAboveSigma(body.width ?? 512, body.height ?? 512, model)
                        : null,
                    use_coords: naiPromptPayload.v4Prompt.use_coords,
                    characterPrompts: naiPromptPayload.characterPrompts,
                    reference_image_multiple: refImages,
                    reference_information_extracted_multiple: refInfo,
                    reference_strength_multiple: refStrength,
                    v4_negative_prompt: naiPromptPayload.v4NegativePrompt,
                    v4_prompt: naiPromptPayload.v4Prompt,
                    ...directorReferenceParams,
                },
            }),
        });

        if (!generateResult.ok) {
            const status = generateResult.status || 500;
            if (status === 429 || errorText.includes('Concurrent generation is locked')) {
                return Response.json({
                    ok: false,
                    statusCode: 429,
                    code: 'AUTOPIC_NAI_CONCURRENT_LOCK',
                    message: 'NovelAI가 아직 이전 이미지 생성을 처리 중입니다. 잠시 후 다시 시도해주세요.',
                }, { status: 429 });
            }
            return textResponse(errorText || generateResult.statusText, status);
        }

        const png = await extractFileFromZip(new Uint8Array(await generateResult.arrayBuffer()), '.png');
        if (!png) return textResponse('PNG was not found in the NAI zip response.', 500);
        return textResponse(await upscaleOrOriginal(body, key, await bytesToBase64(png), signal), 200, headers);
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        console.error('[AutoPic] Proxy error:', error);
        return textResponse(String(error?.message || error), 500);
    }
}

// ── plugin: POST /generate-direct (direct-route.mjs) ─────────────────────────

async function handleGenerateDirect(body, outerSignal) {
    let account;
    let timer;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    try {
        const built = buildDirectRequest(body, randomUint32());
        const key = await readNovelKey();
        if (!key) return Response.json({ message: MISSING_KEY_MESSAGE }, { status: 400 });
        const accountId = await sha256Hex(key);
        if (activeDirectAccounts.has(accountId)) {
            return Response.json({ message: '이 NovelAI 계정의 AutoPic 직접 생성이 진행 중입니다.' }, { status: 429 });
        }
        activeDirectAccounts.add(accountId);
        account = accountId;
        outerSignal?.addEventListener?.('abort', forwardAbort, { once: true });
        timer = setTimeout(() => controller.abort(), 180000);

        const p = built.request.parameters;
        if (built.vibes.length) {
            const encoded = [];
            for (const vibe of built.vibes) {
                controller.signal.throwIfAborted();
                encoded.push(await encodeVibe(vibe.image, built.request.model, key, {
                    direct: true, information: vibe.information, signal: controller.signal,
                }));
            }
            const total = built.vibes.reduce((sum, v) => sum + v.strength, 0);
            p.reference_image_multiple = encoded;
            p.reference_information_extracted_multiple = encoded.map(() => 1);
            p.reference_strength_multiple = built.vibes.map(v => v.strength / (built.normalizeVibes ? Math.max(1, total) : 1));
        }

        const result = await baseFetch(`${IMAGE_NOVELAI}/ai/generate-image`, {
            method: 'POST',
            signal: controller.signal,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/zip' },
            body: JSON.stringify(built.request),
        });
        if (!result.ok) {
            const raw = await result.text();
            let message;
            try { message = JSON.parse(raw).message; } catch { /* non-JSON upstream error */ }
            return Response.json({ message: typeof message === 'string' ? message.slice(0, 500) : `NovelAI 이미지 생성 실패 (HTTP ${result.status})` }, { status: result.status });
        }
        const png = await extractFileFromZip(new Uint8Array(await result.arrayBuffer()), '.png');
        if (!png) return Response.json({ message: 'NovelAI 응답에 PNG 이미지가 없습니다.' }, { status: 502 });
        return textResponse(await bytesToBase64(png), 200, { 'X-AutoPic-Seed': String(p.seed) });
    } catch (error) {
        if (error instanceof DirectInputError) return Response.json({ message: error.message }, { status: 400 });
        if (outerSignal?.aborted) throw error;
        if (controller.signal.aborted) {
            return Response.json({ message: 'NovelAI 요청 시간이 초과되었습니다. 생성 완료 여부를 확인한 뒤 다시 시도해 주세요.' }, { status: 504 });
        }
        console.warn('[AutoPic direct] Request failed:', error);
        return Response.json({ message: 'NovelAI 직접 생성 또는 Vibe 인코딩에 실패했습니다. 설정과 연결을 확인해 주세요.' }, { status: 502 });
    } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener?.('abort', forwardAbort);
        if (account) activeDirectAccounts.delete(account);
    }
}

// ── zip / base64 ─────────────────────────────────────────────────────────────

/**
 * Minimal ZIP reader: returns the bytes of the first entry whose name ends
 * with `suffix` (stored or deflate).
 * @param {Uint8Array} zip
 * @param {string} suffix
 * @returns {Promise<Uint8Array|null>}
 */
export async function extractFileFromZip(zip, suffix) {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const decoder = new TextDecoder();

    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;

    const entryCount = view.getUint16(eocd + 10, true);
    let ptr = view.getUint32(eocd + 16, true);

    for (let n = 0; n < entryCount; n++) {
        if (view.getUint32(ptr, true) !== 0x02014b50) return null;
        const method = view.getUint16(ptr + 10, true);
        const compressedSize = view.getUint32(ptr + 20, true);
        const nameLen = view.getUint16(ptr + 28, true);
        const extraLen = view.getUint16(ptr + 30, true);
        const commentLen = view.getUint16(ptr + 32, true);
        const localOffset = view.getUint32(ptr + 42, true);
        const name = decoder.decode(zip.subarray(ptr + 46, ptr + 46 + nameLen));
        ptr += 46 + nameLen + extraLen + commentLen;

        if (!name.toLowerCase().endsWith(suffix)) continue;

        if (view.getUint32(localOffset, true) !== 0x04034b50) return null;
        const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        const data = zip.subarray(start, start + compressedSize);

        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error(`Unsupported ZIP compression method: ${method}`);
    }
    return null;
}

async function inflateRaw(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

// Install as soon as the module is evaluated: ES imports run before AutoPic's
// index.js body, so this layer ends up underneath AutoPic's NAI interceptor.
installTauriCompat();
