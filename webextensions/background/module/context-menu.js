/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log,
  wait,
  configs
} from '../../common/common.js';
import * as Constants from '../../common/constants.js';
import * as Commands from '../../common/commands.js';

const gContextMenuItems = `
  reloadTabs
  bookmarkTabs
  removeBookmarkFromTabs
  -----------------
  duplicateTabs
  -----------------
  pinTabs
  unpinTabs
  muteTabs
  unmuteTabs
  moveToNewWindow
  moveToOtherWindow
  -----------------
  removeTabs
  removeOther
  -----------------
  clipboard
  saveTabs
  -----------------
  printTabs
  -----------------
  freezeTabs
  unfreezeTabs
  protectTabs
  unprotectTabs
  lockTabs
  unlockTabs
  -----------------
  groupTabs
  -----------------
  suspendTabs
  resumeTabs
  -----------------
  selectAll
  select
  unselect
  invertSelection
  -----------------
`.trim().split(/\s+/).map(aId => `selection/${aId}`);
gContextMenuItems.unshift('selection');

let gActiveContextMenuItems = [];
const gExtraContextMenuItems  = {};

let gLastSelectedTabs = '';

let gLastRefreshStart = Date.now();
export async function refreshContextMenuItems(aContextTab, aForce) {
  log('refreshContextMenuItems');
  const currentRefreshStart = gLastRefreshStart = Date.now();
  const promisedMenuUpdated = [];

  if (reserveRefreshContextMenuItems.timeout)
    clearTimeout(reserveRefreshContextMenuItems.timeout);
  delete reserveRefreshContextMenuItems.timeout;

  const serialized = JSON.stringify(Commands.gSelection.tabs);
  if (!aForce &&
      serialized == gLastSelectedTabs) {
    log(' => no change, skip');
    return;
  }

  promisedMenuUpdated.push(browser.contextMenus.removeAll());
  try {
    promisedMenuUpdated.push(browser.runtime.sendMessage(Constants.kTST_ID, {
      type: Constants.kTSTAPI_CONTEXT_MENU_REMOVE_ALL
    }));
  }
  catch(_e) {
  }
  if (currentRefreshStart != gLastRefreshStart)
    return;
  gActiveContextMenuItems = [];
  gLastSelectedTabs       = serialized;
  const currentWindowId = aContextTab ? aContextTab.windowId : (await browser.windows.getLastFocused()).id;
  const otherWindows = (await browser.windows.getAll()).filter(aWindow => aWindow.id != currentWindowId);
  const visibilities = await getContextMenuItemVisibilities({
    tab:          aContextTab,
    otherWindows: otherWindows
  });
  if (currentRefreshStart != gLastRefreshStart)
    return;
  log('visibilities: ', visibilities);

  const hasSelection         = Commands.getSelectedTabIds().length > 0;
  let separatorsCount      = 0;
  const normalItemAppearedIn = {};
  const createdItems         = {};
  const nextSeparatorIn      = {};
  const registerItem = async (id, aOptions = {}) => {
    const parts = id.split('/');
    id = parts.pop();

    const parentId = parts.pop() || '';
    if (parentId && !(parentId in createdItems))
      return;

    const isSeparator = id.charAt(0) == '-';
    if (isSeparator) {
      if (!normalItemAppearedIn[parentId])
        return;
      normalItemAppearedIn[parentId] = false;
      id = `separator${separatorsCount++}`;
    }
    else {
      if (id in visibilities && !visibilities[id])
        return;
      if (!aOptions.always && !hasSelection)
        return;
      const key = `context_${id}`;
      if (configs[key] === false)
        return;
      normalItemAppearedIn[parentId] = true;
      if (nextSeparatorIn[parentId]) {
        gActiveContextMenuItems.push(nextSeparatorIn[parentId]);
        promisedMenuUpdated.push(browser.contextMenus.create(nextSeparatorIn[parentId]));
        try {
          promisedMenuUpdated.push(browser.runtime.sendMessage(Constants.kTST_ID, {
            type: Constants.kTSTAPI_CONTEXT_MENU_CREATE,
            params: nextSeparatorIn[parentId]
          }));
        }
        catch(_e) {
        }
      }
      delete nextSeparatorIn[parentId];
    }
    log('build ', id, parentId);
    createdItems[id] = true;
    const type = isSeparator ? 'separator' : 'normal';
    let title = null;
    if (!isSeparator) {
      if (aOptions.title)
        title = aOptions.title;
      else
        title = browser.i18n.getMessage(`context_${id.replace(/[^a-z0-9@_]/gi, '_')}_label`);
    }
    const params = {
      id, type, title,
      contexts: ['page', 'tab']
    };
    if (parentId)
      params.parentId = parentId;
    if (isSeparator) {
      nextSeparatorIn[parentId] = params;
      return;
    }
    gActiveContextMenuItems.push(params);
    promisedMenuUpdated.push(browser.contextMenus.create(Object.assign({}, params, {
      // Access key is not supported by WE API.
      // See also: https://bugzilla.mozilla.org/show_bug.cgi?id=1320462
      title: params.title && params.title.replace(/\(&[a-z]\)|&([a-z])/i, '$1')
    })));
    try {
      promisedMenuUpdated.push(browser.runtime.sendMessage(Constants.kTST_ID, {
        type: Constants.kTSTAPI_CONTEXT_MENU_CREATE,
        params
      }));
    }
    catch(_e) {
    }
  }

  for (const id of gContextMenuItems) {
    await registerItem(id);
    if (currentRefreshStart != gLastRefreshStart)
      return;
  }

  // create submenu items for "copy to clipboard"
  let formatIds;
  const formats = configs.copyToClipboardFormats;
  if (Array.isArray(formats)) {
    formatIds = formats
      .map((aItem, aIndex) => `clipboard/clipboard:${aIndex}:${aItem.label}`)
      .filter((aItem, aIndex) => formats[aIndex].label);
  }
  else {
    const labels = Object.keys(formats);
    formatIds = labels
      .map((aLabel, aIndex) => `clipboard/clipboard:${aIndex}:${aLabel}`)
      .filter((aItem, aIndex) => labels[aIndex]);
  }
  for (const id of formatIds) {
    await registerItem(id, {
      title: id.replace(/^clipboard\/clipboard:[0-9]+:/, '')
    });
    if (currentRefreshStart != gLastRefreshStart)
      return;
  }

  // create submenu items for "move to other window"
  for (const window of otherWindows) {
    await registerItem(`moveToOtherWindow/moveToOtherWindow:${window.id}`, {
      title: window.title
    });
    if (currentRefreshStart != gLastRefreshStart)
      return;
  }

  // create additional items registered by other addons
  for (const id of Object.keys(gExtraContextMenuItems)) {
    await registerItem(`selection/extra:${id}`, gExtraContextMenuItems[id]);
    if (currentRefreshStart != gLastRefreshStart)
      return;
  }

  return Promise.all(promisedMenuUpdated);
}

export function reserveRefreshContextMenuItems() {
  if (reserveRefreshContextMenuItems.timeout)
    clearTimeout(reserveRefreshContextMenuItems.timeout);
  reserveRefreshContextMenuItems.timeout = setTimeout(() => {
    refreshContextMenuItems();
  }, 150);
}

export async function getContextMenuItemVisibilities(aParams) {
  const tab = aParams.tab;
  const allTabs = await Commands.getAllTabs();
  let pinnedCount = 0;
  let mutedCount = 0;
  let suspendedCount = 0;
  let lockedCount = 0;
  let protectedCount = 0;
  let frozenCount = 0;
  const tabIds = Commands.getSelectedTabIds();
  for (const id of tabIds) {
    const tab = Commands.gSelection.tabs[id];
    if (tab.pinned)
      pinnedCount++;
    if (tab.mutedInfo.muted)
      mutedCount++;
    if (tab.discarded)
      suspendedCount++;
    if (tab.states && tab.states.indexOf('locked') < 0)
      lockedCount++;
    if (tab.states && tab.states.indexOf('protected') < 0)
      protectedCount++;
    if (tab.states && tab.states.indexOf('frozen') < 0)
      frozenCount++;
  }
  return {
    reloadTabs:    tabIds.length > 0,
    bookmarkTabs:  tabIds.length > 0,
    removeBookmarkFromTabs: tabIds.length > 0,
    duplicateTabs: tabIds.length > 0,
    pinTabs:       tabIds.length > 0 && pinnedCount < tabIds.length,
    unpinTabs:     tabIds.length > 0 && pinnedCount > 0,
    muteTabs:      tabIds.length > 0 && mutedCount < tabIds.length,
    unmuteTabs:    tabIds.length > 0 && mutedCount > 0,
    moveToNewWindow: tabIds.length > 0,
    moveToOtherWindow: tabIds.length > 0 && aParams.otherWindows.length > 0,
    removeTabs:    tabIds.length > 0,
    removeOther:   tabIds.length > 0 && tabIds.length < allTabs.length,
    clipboard:     tabIds.length > 0,
    saveTabs:      tabIds.length > 0,
    printTabs:     tabIds.length > 0,
    freezeTabs:    tabIds.length > 0 && frozenCount < tabIds.length,
    unfreezeTabs:  tabIds.length > 0 && frozenCount > 0,
    protectTabs:   tabIds.length > 0 && protectedCount < tabIds.length,
    unprotectTabs: tabIds.length > 0 && protectedCount > 0,
    lockTabs:      tabIds.length > 0 && lockedCount < tabIds.length,
    unlockTabs:    tabIds.length > 0 && lockedCount > 0,
    groupTabs:     tabIds.length > 1,
    suspendTabs:   tabIds.length > 0 && suspendedCount < tabIds.length,
    resumeTabs:    tabIds.length > 0 && suspendedCount > 0,
    selectAll:     tabIds.length < allTabs.length,
    select:        !tab || tabIds.indexOf(tab.id) < 0,
    unselect:      !tab || tabIds.indexOf(tab.id) > -1,
    invertSelection: tabIds.length > 0
  };
}

/*
configs.$load().then(() => {
  refreshContextMenuItems();
});

configs.$addObserver(aKey => {
  if (aKey.indexOf('context_') == 0)
    refreshContextMenuItems();
});
*/

export async function contextMenuClickListener(aInfo, aTab) {
  //log('context menu item clicked: ', aInfo, aTab);
  const selectedTabIds = Commands.getSelectedTabIds();
  console.log('aInfo.menuItemId, selectedTabIds ', aInfo.menuItemId, selectedTabIds);
  switch (aInfo.menuItemId) {
    case 'reloadTabs':
      await Commands.reloadTabs(selectedTabIds);
      Commands.clearSelection();
      break;
    case 'bookmarkTabs':
      await Commands.bookmarkTabs(selectedTabIds);
      break;
    case 'removeBookmarkFromTabs':
      // not implemented
      break;

    case 'duplicateTabs':
      await Commands.duplicateTabs(selectedTabIds);
      Commands.clearSelection();
      break;

    case 'pinTabs':
      await Commands.pinTabs(selectedTabIds);
      Commands.clearSelection();
      break;
    case 'unpinTabs':
      await Commands.unpinTabs(selectedTabIds);
      Commands.clearSelection();
      break;
    case 'muteTabs':
      await Commands.muteTabs(selectedTabIds);
      Commands.clearSelection();
      break;
    case 'unmuteTabs':
      await Commands.unmuteTabs(selectedTabIds);
      Commands.clearSelection();
      break;

    case 'moveToNewWindow':
      await Commands.moveToWindow(selectedTabIds);
      break;

    case 'removeTabs':
      await Commands.removeTabs(selectedTabIds);
      Commands.clearSelection();
      break;
    case 'removeOther':
      await Commands.removeOtherTabs(selectedTabIds);
      Commands.clearSelection();
      break;

    case 'clipboard':
      Commands.clearSelection();
      break;
    case 'saveTabs':
      await Commands.clearSelection();
      await wait(100); // to wait tab titles are updated
      await Commands.saveTabs(selectedTabIds);
      break;

    case 'printTabs':
      break;

    case 'freezeTabs':
    case 'unfreezeTabs':
    case 'protectTabs':
    case 'unprotectTabs':
    case 'lockTabs':
    case 'unlockTabs':
      break;

    case 'groupTabs':
      await browser.runtime.sendMessage(Constants.kTST_ID, {
        type: Constants.kTSTAPI_GROUP_TABS,
        tabs: selectedTabIds
      }).catch(_e => {});
      break;

    case 'suspendTabs':
      await Commands.suspendTabs(selectedTabIds);
      break;
    case 'resumeTabs':
      await Commands.resumeTabs(selectedTabIds);
      break;

    case 'selectAll':
      Commands.selectAllTabs();
      break;
    case 'select':
      Commands.setSelection(aTab, true);
      break;
    case 'unselect':
      Commands.setSelection(aTab, false);
      break;
    case 'invertSelection':
      Commands.invertSelection();
      break;

    default:
      if (aInfo.menuItemId.indexOf('clipboard:') == 0) {
        const id = aInfo.menuItemId.replace(/^clipboard:/, '');
        let format;
        if (Array.isArray(configs.copyToClipboardFormats)) {
          let index = id.match(/^([0-9]+):/);
          index = parseInt(index[1]);
          const item = configs.copyToClipboardFormats[index];
          format = item.format;
        }
        else {
          format = configs.copyToClipboardFormats[id.replace(/^[0-9]+:/, '')];
        }
        await Commands.clearSelection();
        await wait(100); // to wait tab titles are updated
        await Commands.copyToClipboard(selectedTabIds, format);
      }
      else if (aInfo.menuItemId.indexOf('moveToOtherWindow:') == 0) {
        const id = parseInt(aInfo.menuItemId.replace(/^moveToOtherWindow:/, ''));
        await Commands.moveToWindow(selectedTabIds, id);
        await Commands.clearSelection();
      }
      else if (aInfo.menuItemId.indexOf('extra:') == 0) {
        const idMatch   = aInfo.menuItemId.match(/^extra:([^:]+):(.+)$/);
        const owner     = idMatch[1];
        const id        = idMatch[2];
        const selection = await Commands.getAPITabSelection({
          selectedIds: selectedTabIds
        });
        browser.runtime.sendMessage(owner, {
          type: Constants.kMTHAPI_INVOKE_SELECTED_TAB_COMMAND,
          id, selection
        }).catch(_e => {});
      }
      break;
  }
};
browser.contextMenus.onClicked.addListener(contextMenuClickListener);