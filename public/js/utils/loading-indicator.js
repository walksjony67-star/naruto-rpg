// 加载状态指示器
class LoadingIndicator {
  constructor() {
    this._activeLoaders = new Map();
    this._container = null;
    this._injectStyles();
  }

  show(id = 'default', message = '加载中...') {
    if (!this._container) {
      this._createContainer();
    }

    if (this._activeLoaders.has(id)) {
      // 更新现有加载器的消息
      const loader = this._activeLoaders.get(id);
      const msgEl = loader.querySelector('.loading-message');
      if (msgEl) msgEl.textContent = message;
      return;
    }

    const loader = document.createElement('div');
    loader.className = 'loading-item';
    loader.innerHTML = `
      <div class="loading-spinner"></div>
      <div class="loading-message">${this._escapeHtml(message)}</div>
    `;

    this._container.appendChild(loader);
    this._activeLoaders.set(id, loader);
    this._container.style.display = 'flex';
  }

  hide(id = 'default') {
    const loader = this._activeLoaders.get(id);
    if (!loader) return;

    loader.style.opacity = '0';
    setTimeout(() => {
      if (loader.parentNode) {
        loader.parentNode.removeChild(loader);
      }
      this._activeLoaders.delete(id);

      if (this._activeLoaders.size === 0 && this._container) {
        this._container.style.display = 'none';
      }
    }, 300);
  }

  hideAll() {
    for (const id of this._activeLoaders.keys()) {
      this.hide(id);
    }
  }

  _createContainer() {
    this._container = document.createElement('div');
    this._container.className = 'loading-container';
    this._container.style.display = 'none';
    document.body.appendChild(this._container);
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  _injectStyles() {
    if (document.getElementById('loading-indicator-styles')) return;

    const style = document.createElement('style');
    style.id = 'loading-indicator-styles';
    style.textContent = `
      .loading-container {
        position: fixed;
        bottom: 20px;
        left: 20px;
        z-index: 9999;
        display: flex;
        flex-direction: column;
        gap: 12px;
        pointer-events: none;
      }

      .loading-item {
        display: flex;
        align-items: center;
        gap: 12px;
        background: rgba(15, 13, 12, 0.92);
        border: 1px solid rgba(235, 97, 63, 0.3);
        border-radius: 8px;
        padding: 12px 16px;
        color: #e8e4d9;
        font-size: 13px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        transition: opacity 0.3s ease;
        backdrop-filter: blur(8px);
        max-width: 300px;
      }

      .loading-spinner {
        width: 20px;
        height: 20px;
        border: 2px solid rgba(235, 97, 63, 0.2);
        border-top-color: #eb613f;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        flex-shrink: 0;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .loading-message {
        flex: 1;
        line-height: 1.4;
      }

      @media (max-width: 600px) {
        .loading-container {
          bottom: 10px;
          left: 10px;
          right: 10px;
        }
        .loading-item {
          max-width: none;
        }
      }
    `;
    document.head.appendChild(style);
  }
}

export const loadingIndicator = new LoadingIndicator();
export default loadingIndicator;
