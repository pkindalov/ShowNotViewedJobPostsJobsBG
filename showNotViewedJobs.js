(function () {
  'use strict';
 
  const CONFIG = {
    STORAGE_KEY: 'csJobsData',
    MAX_STORED_JOBS: 500,
    // Wait per scroll attempt. The site loads more jobs via a background
    // request that isn't instant, so this needs real breathing room -
    // a short wait just means we give up before it ever fires.
    SCROLL_DELAY_MS: 2000,
    MAX_SCROLL_ATTEMPTS: 30,
    // How many consecutive "no new jobs matched" checks before we
    // conclude we've hit the real bottom.
    STABLE_CHECKS_REQUIRED: 4,
    // Add/remove selectors here if the site's markup changes -
    // no need to touch anything else in the script. Pages beyond
    // page-2 are included because the site keeps appending page-N
    // containers as you load more (page-3, page-4, ...).
    JOB_SELECTORS: [
      '[class^="page-"] li[additional-params]'
    ]
  };
 
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
 
  // ---------- Storage ----------
 
  const loadJobsDataFromStorage = function () {
    const data = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (data) return JSON.parse(data);
    return [];
  };
 
  const saveJobsData = function (newIdsList, oldSavedIds) {
    const merged = [...new Set([...oldSavedIds, ...newIdsList])];
    const trimmed = merged.slice(-CONFIG.MAX_STORED_JOBS);
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(trimmed));
  };
 
  // ---------- DOM reading ----------
 
  const loadJobsDataFromDOM = function () {
    return CONFIG.JOB_SELECTORS.flatMap((sel) =>
      Array.from(document.querySelectorAll(sel))
    );
  };
 
  const getJobIdentifier = function (item) {
    const link = item.querySelector('a[href]');
    if (link && link.href && !link.href.startsWith('javascript:')) {
      return link.href.split('?')[0];
    }
 
    const idAttr =
      item.getAttribute('additional-params') ||
      item.getAttribute('data-id') ||
      item.id;
    if (idAttr) return idAttr.trim();
 
    const titleEl = item.querySelector('h1, h2, h3, h4, .title, .job-title');
    if (titleEl) return titleEl.textContent.trim();
 
    return item.textContent.trim().replace(/\s+/g, ' ');
  };
 
  // ---------- Scroll + scan (combined) ----------
  //
  // Important: this site only keeps a couple of "pages" worth of job
  // items in the DOM at a time (see .page-1 / .page-2 in the selectors)
  // and discards earlier ones as you scroll further - a windowed list.
  // Scrolling all the way to the bottom FIRST and only comparing at the
  // end doesn't work here, because by the time we check, the DOM node
  // for an earlier "new" job may already be gone. So instead we scan
  // and highlight after every scroll step, while items are still there.
 
  const scanCurrentDom = function (
    oldSavedData,
    seenIds,
    newElements,
    currentBatchIds,
    shouldHighlight
  ) {
    loadJobsDataFromDOM().forEach((item) => {
      const jobId = getJobIdentifier(item);
      if (seenIds.has(jobId)) return; // already handled earlier this run
 
      seenIds.add(jobId);
      currentBatchIds.push(jobId);
 
      if (shouldHighlight && !oldSavedData.includes(jobId)) {
        item.style.backgroundColor = '#e6ffed';
        item.style.border = '2px solid #28a745';
        item.style.borderRadius = '6px';
        newElements.push(item);
      }
    });
  };
 
  // Try to trigger the next page load the way the SITE ITSELF does it,
  // instead of simulating scroll and hoping the site's own listener
  // reacts to it. Digging into the page's own source showed it uses a
  // custom `Scrollable` instance (exposed as `window.pageDataList`) with
  // an IntersectionObserver-based loader - `scrollShowPage()` is the
  // actual method it calls internally to fetch + append the next batch.
  // Calling that directly, verified against the live site repeatedly,
  // works instantly and reliably, and it naturally stops doing anything
  // once there's genuinely nothing left to load - no separate "are we
  // at the end" check needed on our side for this path.
  //
  // Simulated scrolling (window.scrollTo + dispatched events) was tried
  // first and turned out to be unreliable here - the trigger condition
  // depends on internal state that a synthetic scroll doesn't reliably
  // reproduce. It's kept below only as a fallback for sites that don't
  // expose this internal object, so the script still degrades gracefully
  // instead of doing nothing.
  const triggerNextPage = function () {
    if (window.pageDataList && typeof window.pageDataList.scrollShowPage === 'function') {
      window.pageDataList.scrollShowPage();
      return true;
    }
    return false;
  };
 
  // shouldHighlight: false on the very first (baseline) run, since
  // there's nothing to compare against yet - everything would show up
  // as "new" otherwise, which isn't what a baseline save should do.
  //
  // Note on the "are we done" signal: this used to compare
  // document.body.scrollHeight before/after each scroll step, on the
  // usual infinite-scroll assumption that height only grows as more
  // content loads. On this site that assumption is wrong - the total
  // page height can also SHRINK as more jobs load (likely a loading
  // placeholder or ad slot collapsing), which made the old check stop
  // early or behave inconsistently. So instead we track the actual
  // number of matched job elements (seenIds.size) - that only ever
  // goes up when something genuinely new has loaded, which is the
  // thing we actually care about.
  const scrollAndCollectNewJobs = async function (oldSavedData, shouldHighlight) {
    const seenIds = new Set();
    const newElements = [];
    const currentBatchIds = [];
 
    // Scan whatever's already on screen before doing anything else.
    scanCurrentDom(oldSavedData, seenIds, newElements, currentBatchIds, shouldHighlight);
 
    ui.setStatus('Loading all jobs...');
 
    let lastSeenCount = seenIds.size;
    let noChangeCount = 0;
 
    for (let i = 0; i < CONFIG.MAX_SCROLL_ATTEMPTS; i++) {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      const moreBtn = buttons.find((b) =>
        /show more|load more|view more|покажи|зареди|още/i.test(b.innerText || '')
      );
      if (moreBtn && moreBtn.offsetParent !== null) {
        moreBtn.click();
      }
 
      const usedSiteLoader = triggerNextPage();
      if (!usedSiteLoader) {
        // Fallback for a site that doesn't expose the same internal
        // loader - nudge scroll position (not to the same spot twice in
        // a row, since scrolling to an unchanged position fires no new
        // scroll event at all) and dispatch a real scroll event after.
        const max = document.body.scrollHeight;
        window.scrollTo(0, Math.max(0, max - 50));
        window.dispatchEvent(new Event('scroll'));
        await sleep(150);
        window.scrollTo(0, max);
        window.dispatchEvent(new Event('scroll'));
      }
 
      await sleep(CONFIG.SCROLL_DELAY_MS);
 
      // Scan right away, before the site can recycle what just loaded.
      scanCurrentDom(oldSavedData, seenIds, newElements, currentBatchIds, shouldHighlight);
 
      if (seenIds.size === lastSeenCount) {
        noChangeCount++;
        if (noChangeCount >= CONFIG.STABLE_CHECKS_REQUIRED) break;
      } else {
        noChangeCount = 0;
        lastSeenCount = seenIds.size;
        ui.setStatus(`Loading all jobs... (${seenIds.size} found)`);
      }
    }
 
    return { newElements, currentBatchIds, totalSeen: seenIds.size };
  };
 
  // ---------- UI (replaces alert()) ----------
  // A small floating, non-blocking badge instead of alert() popups.
  // alert() freezes the whole page and you can't see it if the tab
  // isn't focused - this stays out of the way and updates in place.
 
  const ui = (function () {
    let badge;
    let statusEl;
    let countEl;
    let progressTrack;
    let toast;
    let newElements = [];
    let cycleIndex = 0;
 
    const jumpToNext = function () {
      // Some job elements can still get recycled by the site's own list
      // rendering after we scan, even though we scan as we scroll -
      // skip anything no longer actually on the page instead of
      // silently doing nothing.
      const stillOnPage = newElements.filter((el) => el.isConnected);
      if (stillOnPage.length === 0) {
        if (statusEl) statusEl.textContent = 'That job is no longer on the page';
        return;
      }
      const target = stillOnPage[cycleIndex % stillOnPage.length];
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      cycleIndex = (cycleIndex + 1) % stillOnPage.length;
    };
 
    const injectStyles = function () {
      if (document.getElementById('snvj-styles')) return;
      const style = document.createElement('style');
      style.id = 'snvj-styles';
      style.textContent = `
        @keyframes snvj-indeterminate {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
        @keyframes snvj-spin {
          to { transform: rotate(360deg); }
        }
        #snvj-badge button {
          height: 28px;
          font-size: 12.5px;
          line-height: 1;
        }
        #snvj-badge button:not(:disabled):hover {
          filter: brightness(1.12);
        }
        #snvj-toast {
          position: fixed;
          top: 16px;
          left: 50%;
          transform: translateX(-50%) translateY(-12px);
          z-index: 1000000;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.2s ease, transform 0.2s ease;
          background: #1f2937;
          color: #fff;
          font: 13px/1.2 -apple-system, sans-serif;
          padding: 9px 16px;
          border-radius: 999px;
          box-shadow: 0 4px 14px rgba(0,0,0,0.3);
          display: flex;
          align-items: center;
          gap: 9px;
        }
        #snvj-toast.snvj-visible {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
        #snvj-toast .snvj-spinner {
          width: 13px;
          height: 13px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: #fff;
          animation: snvj-spin 0.7s linear infinite;
          flex-shrink: 0;
        }
      `;
      document.head.appendChild(style);
    };
 
    const build = function () {
      injectStyles();
 
      badge = document.createElement('div');
      badge.id = 'snvj-badge';
      badge.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        background: #1f2937;
        color: #fff;
        font: 13px/1.4 -apple-system, sans-serif;
        padding: 12px;
        border-radius: 10px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.25);
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 220px;
      `;
 
      statusEl = document.createElement('div');
      statusEl.textContent = 'Ready';
      statusEl.style.cssText =
        'font-size:11px; font-weight:500; color:#9ca3af; text-transform:uppercase; letter-spacing:0.03em;';
 
      progressTrack = document.createElement('div');
      progressTrack.style.cssText = `
        height: 3px;
        border-radius: 999px;
        background: #374151;
        overflow: hidden;
        display: none;
      `;
      const progressBar = document.createElement('div');
      progressBar.style.cssText = `
        height: 100%;
        width: 30%;
        border-radius: 999px;
        background: #28a745;
        animation: snvj-indeterminate 1.1s ease-in-out infinite;
      `;
      progressTrack.appendChild(progressBar);
 
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:stretch; gap:8px;';
 
      countEl = document.createElement('button');
      countEl.type = 'button';
      countEl.style.cssText = `
        flex: 1;
        background:#6b7280; color:#fff; border:none; border-radius:7px;
        padding:0 10px; font-weight:600; cursor:default;
      `;
      countEl.textContent = '';
      countEl.addEventListener('click', () => jumpToNext());
 
      const checkBtn = document.createElement('button');
      checkBtn.type = 'button';
      checkBtn.textContent = 'Check now';
      checkBtn.style.cssText = `
        background:#2563eb; color:#fff; border:none; border-radius:7px;
        padding:0 10px; cursor:pointer; font-weight:500; white-space:nowrap;
      `;
      checkBtn.addEventListener('click', () => run());
 
      row.appendChild(countEl);
      row.appendChild(checkBtn);
 
      badge.appendChild(statusEl);
      badge.appendChild(progressTrack);
      badge.appendChild(row);
      document.body.appendChild(badge);
 
      toast = document.createElement('div');
      toast.id = 'snvj-toast';
      const spinner = document.createElement('div');
      spinner.className = 'snvj-spinner';
      const toastText = document.createElement('span');
      toastText.textContent = 'Checking for new jobs...';
      toast.appendChild(spinner);
      toast.appendChild(toastText);
      document.body.appendChild(toast);
    };
 
    return {
      setStatus(text) {
        if (!badge) build();
        statusEl.textContent = text;
      },
      setProgress(active) {
        if (!badge) build();
        progressTrack.style.display = active ? 'block' : 'none';
        toast.classList.toggle('snvj-visible', !!active);
      },
      setCount(foundElements) {
        if (!badge) build();
        newElements = foundElements || [];
        cycleIndex = 0;
 
        if (newElements.length === 0) {
          countEl.style.background = '#6b7280';
          countEl.style.cursor = 'default';
          countEl.title = '';
          countEl.textContent = 'No new jobs';
        } else {
          countEl.style.background = '#28a745';
          countEl.style.cursor = 'pointer';
          countEl.title = 'Click to jump to the next new job';
          countEl.textContent =
            newElements.length === 1
              ? '1 new job'
              : `${newElements.length} new jobs`;
        }
      }
    };
  })();
 
  // ---------- Main ----------
 
  const run = async function () {
    ui.setStatus('Checking...');
    ui.setProgress(true);
 
    const savedData = loadJobsDataFromStorage();
    const isBaselineRun = savedData.length === 0;
 
    // Always actually scroll and scan on every click - don't pre-check
    // the DOM before scrolling starts. Right after a click, the page
    // may not have any matching items in view yet (e.g. the windowed
    // list has moved on since the last check), which isn't the same
    // as the selectors being wrong. We only decide "nothing found"
    // after a real scroll-and-scan attempt, below.
    const { currentBatchIds, newElements, totalSeen } = await scrollAndCollectNewJobs(
      savedData,
      !isBaselineRun
    );
 
    if (totalSeen === 0) {
      ui.setProgress(false);
      ui.setStatus('No jobs found with current selectors');
      return;
    }
 
    if (isBaselineRun) {
      saveJobsData(currentBatchIds, []);
      ui.setProgress(false);
      ui.setStatus(`Baseline saved (${currentBatchIds.length} jobs)`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
 
    const firstStillOnPage = newElements.find((el) => el.isConnected);
    if (firstStillOnPage) {
      firstStillOnPage.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
 
    ui.setProgress(false);
    ui.setStatus('Done');
    ui.setCount(newElements);
 
    saveJobsData(currentBatchIds, savedData);
  };
 
  // Manual only - the badge is built and left idle. Nothing scans
  // automatically on page load; you decide when to check by clicking
  // "Check now", and can click it again anytime without reloading.
  const init = function () {
    ui.setStatus('Ready - click "Check now"');
  };
 
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();