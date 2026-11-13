const dialog = document.getElementById('figure-dialog');
document.querySelectorAll('.figure-open').forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    const img = link.querySelector('img');
    document.getElementById('figure-title').textContent = link.closest('figure').querySelector('figcaption').textContent;
    const expanded = document.getElementById('figure-expanded');
    expanded.src = link.href;
    expanded.alt = img.alt;
    dialog.showModal();
  });
});
document.getElementById('figure-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
document.querySelector('[data-detail]').addEventListener('click', event => {
  const button = event.currentTarget;
  window.dispatchEvent(new CustomEvent('choose-reconstruction', {
    detail: {dataset: button.dataset.dataset, group: button.dataset.group}
  }));
});
