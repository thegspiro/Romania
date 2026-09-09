/**
 * Passkey ceremonies in the browser.
 *
 * Progressive enhancement: the page works without this script insofar as it
 * shows the operator what is wrong and offers the recovery-code path. The
 * WebAuthn call itself cannot be done without JavaScript.
 *
 * The CSRF token is read from a data attribute rather than a cookie, because
 * the CSRF cookie is HttpOnly and therefore invisible here on purpose.
 */
(function () {
  'use strict';

  var api = window.SimpleWebAuthnBrowser;
  var errorBox = document.getElementById('passkey-error');
  var button = document.getElementById('passkey-button');
  var registerPanel = document.getElementById('passkey-register');
  var authenticatePanel = document.getElementById('passkey-authenticate');
  var panel = registerPanel || authenticatePanel;

  if (!button || !panel) return;

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() {
    if (!errorBox) return;
    errorBox.textContent = '';
    errorBox.hidden = true;
  }

  if (!api) {
    showError('The passkey library failed to load. Reload the page and try again.');
    button.disabled = true;
    return;
  }

  if (!api.browserSupportsWebAuthn()) {
    showError(
      'This browser does not support passkeys. Use a different browser, or sign in with a recovery code.',
    );
    button.disabled = true;
    return;
  }

  var csrf = panel.getAttribute('data-csrf') || '';
  var optionsUrl = panel.getAttribute('data-options-url');
  var verifyUrl = panel.getAttribute('data-verify-url');
  var isRegistration = panel === registerPanel;

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify(body || {}),
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (payload) {
          if (!response.ok) {
            throw new Error(payload.error || 'Request failed (' + response.status + ').');
          }
          return payload;
        });
    });
  }

  button.addEventListener('click', function () {
    clearError();
    button.disabled = true;

    post(optionsUrl, {})
      .then(function (options) {
        return isRegistration
          ? api.startRegistration({ optionsJSON: options })
          : api.startAuthentication({ optionsJSON: options });
      })
      .then(function (credential) {
        var payload = credential;
        if (isRegistration) {
          var labelInput = document.getElementById('passkey-label');
          payload = Object.assign({}, credential, {
            label: labelInput ? labelInput.value : '',
          });
        }
        return post(verifyUrl, payload);
      })
      .then(function (result) {
        window.location.assign(result.redirect || '/admin');
      })
      .catch(function (error) {
        button.disabled = false;
        // A cancelled prompt is not a failure worth alarming the operator over.
        if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
          showError('The passkey prompt was dismissed. Try again when ready.');
          return;
        }
        showError((error && error.message) || 'Something went wrong with the passkey.');
      });
  });
})();
