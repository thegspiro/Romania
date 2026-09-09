/**
 * The essay editor: reference picker and preview.
 *
 * Progressive enhancement. Without JavaScript the textarea is still a working
 * Markdown editor and the form still saves; what is lost is the convenience of
 * picking a reference and seeing it rendered before publishing.
 *
 * The picker never asks the author to type the reference syntax. It inserts
 * the text the server tells it to, so how a reference is spelled is defined in
 * exactly one place -- `formatReference` in src/content/references.ts.
 */
(function () {
  'use strict';

  var editor = document.getElementById('essay-editor');
  var textarea = document.getElementById('bodyMarkdown');
  if (!editor || !textarea) return;

  var search = document.getElementById('reference-search');
  var kindSelect = document.getElementById('reference-kind');
  var results = document.getElementById('reference-results');
  var previewButton = document.getElementById('editor-preview');
  var previewPane = document.getElementById('editor-preview-pane');
  var previewBody = document.getElementById('preview-body');
  var previewFootnotes = document.getElementById('preview-footnotes');
  var csrf = editor.getAttribute('data-csrf') || '';

  // --- Reference picker ----------------------------------------------------

  var searchTimer = null;

  function clearResults() {
    if (!results) return;
    results.textContent = '';
    results.hidden = true;
  }

  function insertAtCursor(text) {
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var value = textarea.value;

    textarea.value = value.slice(0, start) + text + value.slice(end);
    var caret = start + text.length;
    textarea.setSelectionRange(caret, caret);
    textarea.focus();
  }

  function renderResults(items) {
    if (!results) return;
    results.textContent = '';

    if (items.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'reference-empty';
      empty.textContent = 'Nothing found.';
      results.appendChild(empty);
      results.hidden = false;
      return;
    }

    items.forEach(function (item) {
      var entry = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'reference-result';

      // textContent throughout: titles are author-supplied data, never markup.
      var title = document.createElement('span');
      title.className = 'reference-title';
      title.textContent = item.title;

      var meta = document.createElement('span');
      meta.className = 'reference-meta';
      meta.textContent = item.kind + (item.visibility === 'public' ? '' : ' · private');

      button.appendChild(title);
      button.appendChild(meta);

      button.addEventListener('click', function () {
        var selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).trim();
        // A selection becomes the display text, so linking a name already in
        // the prose reads naturally.
        var display = selected !== '' ? selected : item.title;
        insertAtCursor('[[' + item.reference + '|' + display.replace(/[\]\n]/g, '') + ']]');
        if (search) search.value = '';
        clearResults();
      });

      entry.appendChild(button);
      results.appendChild(entry);
    });

    results.hidden = false;
  }

  function runSearch() {
    if (!search) return;
    var term = search.value.trim();
    if (term.length < 2) {
      clearResults();
      return;
    }

    var kind = kindSelect ? kindSelect.value : 'all';
    fetch(
      '/admin/reference-search?q=' + encodeURIComponent(term) + '&kind=' + encodeURIComponent(kind),
      { credentials: 'same-origin', headers: { Accept: 'application/json' } },
    )
      .then(function (response) {
        if (!response.ok) throw new Error('Search failed (' + response.status + ').');
        return response.json();
      })
      .then(function (payload) {
        renderResults(payload.results || []);
      })
      .catch(function () {
        clearResults();
      });
  }

  if (search) {
    search.addEventListener('input', function () {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(runSearch, 200);
    });

    search.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') clearResults();
      // Enter in the search box must not submit the form.
      if (event.key === 'Enter') event.preventDefault();
    });
  }

  if (kindSelect) kindSelect.addEventListener('change', runSearch);

  // --- Preview -------------------------------------------------------------

  if (previewButton && previewPane && previewBody) {
    previewButton.addEventListener('click', function () {
      if (!previewPane.hidden) {
        previewPane.hidden = true;
        previewButton.textContent = 'Preview';
        return;
      }

      previewButton.disabled = true;
      var body = new URLSearchParams();
      body.set('_csrf', csrf);
      body.set('bodyMarkdown', textarea.value);

      fetch('/admin/essays/preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-Token': csrf,
        },
        body: body.toString(),
      })
        .then(function (response) {
          if (!response.ok) throw new Error('Preview failed (' + response.status + ').');
          return response.json();
        })
        .then(function (payload) {
          // The fragment was produced by the server's own renderer with raw
          // HTML disabled, so it contains only tags that renderer emits.
          previewBody.innerHTML = payload.html;

          if (previewFootnotes) {
            previewFootnotes.textContent = '';
            (payload.footnotes || []).forEach(function (note) {
              var item = document.createElement('li');
              item.id = 'fn-' + note.number;
              item.innerHTML = note.html;
              previewFootnotes.appendChild(item);
            });
          }

          previewPane.hidden = false;
          previewButton.textContent = 'Hide preview';
        })
        .catch(function (error) {
          previewBody.textContent = error.message;
          previewPane.hidden = false;
        })
        .finally(function () {
          previewButton.disabled = false;
        });
    });
  }
})();
