/**
 * The prose editor: reference picker, preview, and slug type-ahead.
 *
 * Progressive enhancement. Without JavaScript the textarea is still a working
 * Markdown editor, the slug fields are still text inputs, and every form still
 * saves; what is lost is the convenience of picking a reference, seeing it
 * rendered before publishing, and not having to remember a slug.
 *
 * The picker never asks the author to type the reference syntax. It inserts
 * the text the server tells it to, so how a reference is spelled is defined in
 * exactly one place -- `formatReference` in src/content/references.ts.
 *
 * The editor binds to `[data-editor]` rather than to the essay form's id, so
 * the same enhancement serves the entity forms -- a person's biography and an
 * event's account are prose with references in them for the same reasons an
 * essay is.
 */
(function () {
  'use strict';

  var editor = document.querySelector('[data-editor]');
  if (!editor) return;

  var textarea = document.getElementById(editor.getAttribute('data-editor') || '');
  if (!textarea) return;

  var search = document.getElementById('reference-search');
  var kindSelect = document.getElementById('reference-kind');
  var results = document.getElementById('reference-results');
  var previewButton = document.getElementById('editor-preview');
  var previewPane = document.getElementById('editor-preview-pane');
  var previewBody = document.getElementById('preview-body');
  var previewFootnotes = document.getElementById('preview-footnotes');
  var csrf = editor.getAttribute('data-csrf') || '';
  var previewUrl = editor.getAttribute('data-preview-url') || '/admin/essays/preview';

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

      fetch(previewUrl, {
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

/**
 * Slug type-ahead.
 *
 * A relationship and an event's place are both recorded by typing the other
 * item's slug, which means remembering it. This fills a native <datalist> from
 * the same admin search the reference picker uses, so the field keeps working
 * exactly as before with JavaScript off -- it just stops requiring recall.
 *
 * The list is scoped by `data-slug-picker`, or by another control named in
 * `data-slug-picker-kind-from` when the kind is itself a choice on the form.
 */
(function () {
  'use strict';

  var inputs = document.querySelectorAll('input[data-slug-picker]');
  if (inputs.length === 0) return;

  Array.prototype.forEach.call(inputs, function (input) {
    var datalist = document.getElementById(input.getAttribute('list') || '');
    if (!datalist) return;

    var fixedKind = input.getAttribute('data-slug-picker') || 'all';
    var kindSource = document.getElementById(
      input.getAttribute('data-slug-picker-kind-from') || '',
    );
    var timer = null;
    var lastQuery = '';

    function fill() {
      var term = input.value.trim();
      var kind = kindSource ? kindSource.value : fixedKind;
      var query = kind + ' ' + term;

      // Typing a slug that was just picked would otherwise re-query on every
      // keystroke that changes nothing.
      if (term.length < 2 || query === lastQuery) return;
      lastQuery = query;

      fetch(
        '/admin/reference-search?q=' +
          encodeURIComponent(term) +
          '&kind=' +
          encodeURIComponent(kind),
        { credentials: 'same-origin', headers: { Accept: 'application/json' } },
      )
        .then(function (response) {
          if (!response.ok) throw new Error('Search failed (' + response.status + ').');
          return response.json();
        })
        .then(function (payload) {
          datalist.textContent = '';
          (payload.results || []).forEach(function (item) {
            var option = document.createElement('option');
            // The value is the slug, because that is what the field stores.
            option.value = item.slug;
            // textContent, not markup: titles are author-supplied data.
            option.label = item.title + (item.visibility === 'public' ? '' : ' · private');
            datalist.appendChild(option);
          });
        })
        .catch(function () {
          // A failed lookup leaves the field exactly as usable as it was
          // before this script ran.
          datalist.textContent = '';
        });
    }

    input.addEventListener('input', function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(fill, 200);
    });

    if (kindSource) {
      kindSource.addEventListener('change', function () {
        lastQuery = '';
        fill();
      });
    }
  });
})();
