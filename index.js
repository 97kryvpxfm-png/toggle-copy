import { getRequestHeaders } from "../../../../script.js";
import { getPresetManager } from "../../../preset-manager.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { openai_settings, openai_setting_names } from "../../../openai.js";

const extensionName = "toggle-copy";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const DUMMY_ID = 100001;

// Debounced injection — wait for ST to finish re-rendering the list
let injectTimeout = null;
function scheduleInjection() {
    clearTimeout(injectTimeout);
    injectTimeout = setTimeout(injectCopyButtons, 100);
}

function injectCopyButtons() {
    const rows = document.querySelectorAll(
        'li.completion_prompt_manager_prompt:not(.completion_prompt_manager_marker)'
    );
    rows.forEach(row => {
        if (row.querySelector('.ppc-copy-btn')) return;
        const controls = row.querySelector('.prompt_manager_prompt_controls');
        if (!controls) return;
        const identifier = row.dataset.pmIdentifier;
        if (!identifier) return;

        const btn = document.createElement('span');
        btn.className = 'ppc-copy-btn fa-solid fa-copy fa-xs';
        btn.title = 'Copy to another preset';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            handleCopyClick(identifier);
        });
        controls.prepend(btn);
    });
}

function setupObserver() {
    const container = document.getElementById('completion_prompt_manager');
    if (!container) {
        setTimeout(setupObserver, 500);
        return;
    }
    const observer = new MutationObserver(scheduleInjection);
    observer.observe(container, { childList: true, subtree: true });
    injectCopyButtons();
}

async function handleCopyClick(identifier) {
    const manager = getPresetManager();
    if (!manager) { toastr.error('Preset manager not available'); return; }

    // Read prompt from current live settings
    const { settings } = manager.getPresetList();
    const prompt = settings?.prompts?.find(p => p.identifier === identifier);
    if (!prompt) { toastr.error('Prompt not found'); return; }

    // All preset names except current
    const allNames = Object.keys(openai_setting_names);
    const currentName = manager.getSelectedPresetName();
    const otherPresets = allNames.filter(n => n !== currentName);

    if (!otherPresets.length) { toastr.warning('No other presets to copy to'); return; }

    const options = otherPresets
        .map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
        .join('');

    const html = `
        <div style="min-width:280px">
            <p style="margin-bottom:8px">Copy <b>${escapeHtml(prompt.name)}</b> to:</p>
            <select id="ppc_target_select" class="text_pole" style="width:100%">${options}</select>
        </div>`;

    let selectedTarget = otherPresets[0];
    $(document).on('change', '#ppc_target_select', function () { selectedTarget = this.value; });

    const confirmed = await callGenericPopup(html, POPUP_TYPE.CONFIRM);
    $(document).off('change', '#ppc_target_select');
    if (!confirmed) return;

    await copyPromptToPreset(prompt, selectedTarget);
}

async function copyPromptToPreset(prompt, targetName) {
    try {
        const idx = openai_setting_names[targetName];
        if (idx === undefined) { toastr.error(`Preset "${targetName}" not found`); return; }

        // Live reference — modifications reflect in memory immediately
        const target = openai_settings[idx];
        if (!target) { toastr.error(`Preset "${targetName}" not found`); return; }

        if (!Array.isArray(target.prompts)) target.prompts = [];
        if (!Array.isArray(target.prompt_order)) target.prompt_order = [];

        const alreadyInPrompts = target.prompts.some(p => p.identifier === prompt.identifier);
        if (!alreadyInPrompts) {
            target.prompts.push(structuredClone(prompt));
        }

        // Add to every existing prompt_order entry (covers all characters + global)
        let addedToOrder = false;
        for (const entry of target.prompt_order) {
            if (!Array.isArray(entry.order)) entry.order = [];
            if (!entry.order.some(o => o.identifier === prompt.identifier)) {
                entry.order.unshift({ identifier: prompt.identifier, enabled: true });
                addedToOrder = true;
            }
        }

        // Ensure DUMMY_ID entry exists
        let dummyEntry = target.prompt_order.find(o => String(o.character_id) === String(DUMMY_ID));
        if (!dummyEntry) {
            dummyEntry = { character_id: DUMMY_ID, order: [] };
            target.prompt_order.push(dummyEntry);
        }
        if (!dummyEntry.order.some(o => o.identifier === prompt.identifier)) {
            dummyEntry.order.unshift({ identifier: prompt.identifier, enabled: true });
            addedToOrder = true;
        }

        if (alreadyInPrompts && !addedToOrder) {
            toastr.warning(`"${prompt.name}" already exists in "${targetName}"`);
            return;
        }

        const response = await fetch('/api/presets/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ apiId: 'openai', name: targetName, preset: target }),
        });

        if (!response.ok) throw new Error(await response.text());

        toastr.success(`"${prompt.name}" copied to "${targetName}"`);

    } catch (err) {
        console.error(`[${extensionName}] Copy failed:`, err);
        toastr.error('Failed to copy prompt');
    }
}

function escapeHtml(str) {
    return (str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);
        setupObserver();
    } catch (err) {
        console.error(`[${extensionName}] ❌ Failed:`, err);
    }
});
