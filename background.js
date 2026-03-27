/**
 * background.js - Service Worker (Manifest V3)
 * 툴바 아이콘 클릭 시 viewer.html을 새 탭으로 엽니다.
 * MV3에서는 background page 대신 Service Worker를 사용합니다.
 */
chrome.action.onClicked.addListener((_tab) => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("pages/viewer.html"),
  });
});
