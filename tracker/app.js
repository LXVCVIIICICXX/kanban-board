(function () {
  window.Amogus = window.Amogus || {};

  // Кастомный confirm на промисах
  const confirmOverlay = document.getElementById('confirm-modal');
  const confirmText = document.getElementById('confirm-modal-text');
  const confirmCancel = document.getElementById('confirm-modal-cancel');
  const confirmOk = document.getElementById('confirm-modal-ok');
  let confirmResolve = null;

  if (confirmOverlay && confirmText && confirmCancel && confirmOk) {
    window.Amogus.confirmModal = function (text) {
      confirmText.textContent = text || 'Вы уверены?';
      confirmOverlay.classList.add('open');
      return new Promise((resolve) => {
        confirmResolve = resolve;
      });
    };

    confirmCancel.addEventListener('click', () => {
      confirmOverlay.classList.remove('open');
      if (confirmResolve) confirmResolve(false);
    });

    confirmOk.addEventListener('click', () => {
      confirmOverlay.classList.remove('open');
      if (confirmResolve) confirmResolve(true);
    });

    confirmOverlay.addEventListener('click', (e) => {
      if (e.target === confirmOverlay) {
        confirmOverlay.classList.remove('open');
        if (confirmResolve) confirmResolve(false);
      }
    });
  } else {
    // Фолбэк на стандартный браузерный confirm
    window.Amogus.confirmModal = async function (text) {
      return confirm(text);
    };
  }

  // Временное изменение текста кнопки при успехе (копирование)
  window.Amogus.flashSuccess = function (button, duration = 1000) {
    if (!button) return;
    const oldText = button.textContent;
    const oldTitle = button.title;
    button.textContent = '✓';
    button.title = 'Скопировано!';
    button.style.borderColor = '#22c55e';
    button.style.color = '#22c55e';
    
    setTimeout(() => {
      button.textContent = oldText;
      button.title = oldTitle;
      button.style.borderColor = '';
      button.style.color = '';
    }, duration);
  };
})();
