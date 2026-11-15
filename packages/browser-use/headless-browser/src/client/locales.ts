/** Copy of the 浏览器接管 page and its sidebar entry; the Chinese dictionary is the key source of truth. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  'nav.page': '浏览器接管',
  'page.title': '浏览器接管',
  'state.agent': 'agent 控制',
  'state.human': '你控制',
  'action.take': '接管',
  'action.release': '交回',
  'reason.take': '用户从应用内的浏览器接管页取得控制',
  'hint.agent': '点「接管」后可以操作浏览器',
  'hint.human': '输入会发给浏览器',
  'url.empty': '浏览器还没打开页面',
  'viewers': '{count} 个查看者',
  'stage.alt': '浏览器画面',
  'stage.waiting': '等待浏览器…',
  'connect.lost': '连接断开，正在重连',
  'insert.placeholder': '输入文本后回车插入',
}

/** The keys this namespace owns. */
export type HeadlessBrowserKey = keyof typeof zh

/** English dictionary. */
export const en: Record<HeadlessBrowserKey, string> = {
  'nav.page': 'Browser takeover',
  'page.title': 'Browser takeover',
  'state.agent': 'Agent in control',
  'state.human': 'You are in control',
  'action.take': 'Take over',
  'action.release': 'Hand back',
  'reason.take': 'The user took the browser from the in-app take-over page',
  'hint.agent': 'Take over to operate the browser',
  'hint.human': 'Your input goes to the browser',
  'url.empty': 'The browser has no page open yet',
  'viewers': '{count} viewers',
  'stage.alt': 'Browser screen',
  'stage.waiting': 'Waiting for the browser…',
  'connect.lost': 'Connection lost, reconnecting',
  'insert.placeholder': 'Type text and press Enter to insert',
}

/** Japanese dictionary. */
export const ja: Record<HeadlessBrowserKey, string> = {
  'nav.page': 'ブラウザ引き継ぎ',
  'page.title': 'ブラウザ引き継ぎ',
  'state.agent': 'agent が操作中',
  'state.human': 'あなたが操作中',
  'action.take': '引き継ぐ',
  'action.release': '返す',
  'reason.take': 'ユーザーがアプリ内の引き継ぎ画面から操作を取得しました',
  'hint.agent': '「引き継ぐ」でブラウザを操作できます',
  'hint.human': '入力はブラウザに送られます',
  'url.empty': 'ブラウザはまだページを開いていません',
  'viewers': '{count} 人が閲覧中',
  'stage.alt': 'ブラウザ画面',
  'stage.waiting': 'ブラウザを待っています…',
  'connect.lost': '接続が切れました。再接続中',
  'insert.placeholder': 'テキストを入力して Enter で挿入',
}

/** Spanish dictionary. */
export const es: Record<HeadlessBrowserKey, string> = {
  'nav.page': 'Toma del navegador',
  'page.title': 'Toma del navegador',
  'state.agent': 'El agente controla',
  'state.human': 'Tú controlas',
  'action.take': 'Tomar el control',
  'action.release': 'Devolver',
  'reason.take': 'El usuario tomó el navegador desde la página de la app',
  'hint.agent': 'Toma el control para operar el navegador',
  'hint.human': 'Tu entrada va al navegador',
  'url.empty': 'El navegador aún no tiene una página abierta',
  'viewers': '{count} visores',
  'stage.alt': 'Pantalla del navegador',
  'stage.waiting': 'Esperando al navegador…',
  'connect.lost': 'Conexión perdida, reconectando',
  'insert.placeholder': 'Escribe texto y pulsa Intro para insertarlo',
}

/** French dictionary. */
export const fr: Record<HeadlessBrowserKey, string> = {
  'nav.page': 'Prise en main du navigateur',
  'page.title': 'Prise en main du navigateur',
  'state.agent': "L'agent contrôle",
  'state.human': 'Vous contrôlez',
  'action.take': 'Prendre la main',
  'action.release': 'Rendre la main',
  'reason.take': "L'utilisateur a pris la main depuis la page de l'application",
  'hint.agent': 'Prenez la main pour utiliser le navigateur',
  'hint.human': 'Votre saisie est envoyée au navigateur',
  'url.empty': "Le navigateur n'a pas encore de page ouverte",
  'viewers': '{count} spectateurs',
  'stage.alt': 'Écran du navigateur',
  'stage.waiting': 'En attente du navigateur…',
  'connect.lost': 'Connexion perdue, reconnexion',
  'insert.placeholder': 'Saisissez du texte puis Entrée pour insérer',
}

/** German dictionary. */
export const de: Record<HeadlessBrowserKey, string> = {
  'nav.page': 'Browser-Übernahme',
  'page.title': 'Browser-Übernahme',
  'state.agent': 'Agent steuert',
  'state.human': 'Du steuerst',
  'action.take': 'Übernehmen',
  'action.release': 'Zurückgeben',
  'reason.take': 'Der Nutzer hat den Browser in der App übernommen',
  'hint.agent': 'Übernehmen, um den Browser zu bedienen',
  'hint.human': 'Deine Eingabe geht an den Browser',
  'url.empty': 'Der Browser hat noch keine Seite geöffnet',
  'viewers': '{count} Zuschauer',
  'stage.alt': 'Browserbildschirm',
  'stage.waiting': 'Warte auf den Browser…',
  'connect.lost': 'Verbindung verloren, verbinde neu',
  'insert.placeholder': 'Text eingeben und mit Enter einfügen',
}

/** Russian dictionary. */
export const ru: Record<HeadlessBrowserKey, string> = {
  'nav.page': 'Перехват браузера',
  'page.title': 'Перехват браузера',
  'state.agent': 'Управляет агент',
  'state.human': 'Управляете вы',
  'action.take': 'Перехватить',
  'action.release': 'Вернуть',
  'reason.take': 'Пользователь перехватил браузер из приложения',
  'hint.agent': 'Перехватите управление, чтобы работать с браузером',
  'hint.human': 'Ваш ввод уходит в браузер',
  'url.empty': 'В браузере ещё не открыта страница',
  'viewers': 'Зрителей: {count}',
  'stage.alt': 'Экран браузера',
  'stage.waiting': 'Ожидание браузера…',
  'connect.lost': 'Соединение потеряно, переподключение',
  'insert.placeholder': 'Введите текст и нажмите Enter',
}

/** Portuguese dictionary. */
export const pt: Record<HeadlessBrowserKey, string> = {
  'nav.page': 'Controle do navegador',
  'page.title': 'Controle do navegador',
  'state.agent': 'O agente controla',
  'state.human': 'Você controla',
  'action.take': 'Assumir',
  'action.release': 'Devolver',
  'reason.take': 'O usuário assumiu o navegador pela página do aplicativo',
  'hint.agent': 'Assuma o controle para operar o navegador',
  'hint.human': 'Sua entrada vai para o navegador',
  'url.empty': 'O navegador ainda não abriu uma página',
  'viewers': '{count} espectadores',
  'stage.alt': 'Tela do navegador',
  'stage.waiting': 'Aguardando o navegador…',
  'connect.lost': 'Conexão perdida, reconectando',
  'insert.placeholder': 'Digite o texto e pressione Enter para inserir',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The take-over page and its sidebar entry. */
    'headless-browser': HeadlessBrowserKey
  }
}
