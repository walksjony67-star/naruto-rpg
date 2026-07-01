// 全局错误处理器
class ErrorHandler {
  constructor() {
    this._errorLog = [];
    this._maxLogSize = 50;
    this._setupGlobalHandlers();
  }

  _setupGlobalHandlers() {
    // 捕获未处理的 Promise rejection
    window.addEventListener('unhandledrejection', (event) => {
      event.preventDefault();
      this.handleError(event.reason, 'promise');
    });

    // 捕获全局 JavaScript 错误
    window.addEventListener('error', (event) => {
      event.preventDefault();
      this.handleError(event.error || event.message, 'runtime');
    });
  }

  handleError(error, type = 'unknown', context = {}) {
    const errorInfo = {
      message: this._extractMessage(error),
      type,
      context,
      timestamp: Date.now(),
      stack: error?.stack || new Error().stack
    };

    this._logError(errorInfo);
    this._showUserFriendlyError(errorInfo);

    // 开发环境输出详细错误
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      console.error('[ErrorHandler]', errorInfo);
    }
  }

  _extractMessage(error) {
    if (typeof error === 'string') return error;
    if (error?.message) return error.message;
    if (error?.reason) return error.reason;
    return '未知错误';
  }

  _logError(errorInfo) {
    this._errorLog.push(errorInfo);
    if (this._errorLog.length > this._maxLogSize) {
      this._errorLog.shift();
    }

    // 存储到 localStorage 供调试
    try {
      const recentErrors = this._errorLog.slice(-10);
      localStorage.setItem('naruto_error_log', JSON.stringify(recentErrors));
    } catch (e) {
      // localStorage 可能不可用
    }
  }

  _showUserFriendlyError(errorInfo) {
    const existingToast = document.querySelector('.error-toast');
    if (existingToast) {
      existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.innerHTML = `
      <div class="error-toast-content">
        <div class="error-toast-icon">⚠️</div>
        <div class="error-toast-body">
          <div class="error-toast-title">操作失败</div>
          <div class="error-toast-message">${this._getUserFriendlyMessage(errorInfo)}</div>
        </div>
        <button class="error-toast-close" aria-label="关闭">×</button>
      </div>
    `;

    this._injectStyles();
    document.body.appendChild(toast);

    const closeBtn = toast.querySelector('.error-toast-close');
    closeBtn.addEventListener('click', () => toast.remove());

    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 8000);
  }

  _getUserFriendlyMessage(errorInfo) {
    const msg = errorInfo.message.toLowerCase();

    if (msg.includes('network') || msg.includes('fetch')) {
      return '网络连接失败，请检查网络设置后重试';
    }
    if (msg.includes('api') || msg.includes('401') || msg.includes('403')) {
      return 'API 密钥无效或已过期，请在设置中重新配置';
    }
    if (msg.includes('quota') || msg.includes('storage')) {
      return '存储空间不足，请清理浏览器缓存或导出存档';
    }
    if (msg.includes('parse') || msg.includes('json')) {
      return 'AI 响应格式异常，请稍后重试';
    }
    if (msg.includes('timeout')) {
      return '请求超时，请检查网络连接';
    }

    return '操作遇到问题，已记录错误日志。如持续出现请刷新页面';
  }

  _injectStyles() {
    if (document.getElementById('error-handler-styles')) return;

    const style = document.createElement('style');
    style.id = 'error-handler-styles';
    style.textContent = `
      .error-toast {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 10000;
        max-width: 400px;
        background: rgba(235, 97, 63, 0.95);
        color: #fff;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        animation: slideIn 0.3s ease;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      @keyframes slideIn {
        from { transform: translateX(400px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      .error-toast-content {
        display: flex;
        align-items: flex-start;
        padding: 16px;
        gap: 12px;
      }
      .error-toast-icon {
        font-size: 24px;
        flex-shrink: 0;
      }
      .error-toast-body {
        flex: 1;
        min-width: 0;
      }
      .error-toast-title {
        font-weight: 600;
        font-size: 14px;
        margin-bottom: 4px;
      }
      .error-toast-message {
        font-size: 13px;
        opacity: 0.95;
        line-height: 1.4;
      }
      .error-toast-close {
        background: none;
        border: none;
        color: #fff;
        font-size: 24px;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
        line-height: 20px;
        flex-shrink: 0;
        opacity: 0.8;
        transition: opacity 0.2s;
      }
      .error-toast-close:hover {
        opacity: 1;
      }
      @media (max-width: 600px) {
        .error-toast {
          top: 10px;
          right: 10px;
          left: 10px;
          max-width: none;
        }
      }
    `;
    document.head.appendChild(style);
  }

  getErrorLog() {
    return [...this._errorLog];
  }

  clearErrorLog() {
    this._errorLog = [];
    try {
      localStorage.removeItem('naruto_error_log');
    } catch (e) {}
  }
}

export const errorHandler = new ErrorHandler();
export default errorHandler;
