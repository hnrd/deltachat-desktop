import { C } from 'deltachat-node'
import { app as rawApp, dialog, ipcMain, shell } from 'electron'
import { copy, copyFile, emptyDir, ensureDir, pathExists } from 'fs-extra'
import { extname, join, relative } from 'path'
import { getLogger } from '../shared/logger'
import {
  AppState,
  Credentials,
  LocalSettings,
  DeltaChatAccount,
} from '../shared/shared-types'
import { getConfigPath, getLogsPath } from './application-constants'
import { credential_config } from './deltachat/login'
import loadTranslations from './load-translations'
import { LogHandler } from './log-handler'
import { getLogins, getNewAccountPath, removeAccount } from './logins'
import { init as refreshMenu } from './menu'
import { ExtendedAppMainProcess } from './types'
import * as mainWindow from './windows/main'
import { openHelpWindow } from './windows/help'
import { openCallWindow } from './windows/call'

const log = getLogger('main/ipc')
const DeltaChatController: typeof import('./deltachat/controller').default = (() => {
  try {
    return require('./deltachat/controller').default
  } catch (error) {
    log.critical(
      "Fatal: The DeltaChat Module couldn't be loaded. Please check if all dependencies for deltachat-core are installed!",
      error
    )
    dialog.showErrorBox(
      'Fatal Error',
      `The DeltaChat Module couldn't be loaded.\n Please check if all dependencies for deltachat-core are installed!\n The Log file is located in this folder: ${getLogsPath()}`
    )
  }
})()

const app = rawApp as ExtendedAppMainProcess

export function init(cwd: string, state: AppState, logHandler: LogHandler) {
  const main = mainWindow
  const dcController = new DeltaChatController(cwd)

  dcController.on('ready', async (credentials: Credentials) => {
    if (!state.logins.find(({ addr }) => addr === credentials.addr)) {
      state.logins = await getLogins()
    }
    // update saved / last account + make sure no passwords are present
    state.saved.credentials = {
      ...credentials,
      mail_pw: undefined,
      send_pw: undefined,
    } as Credentials
    app.saveState()
  })

  dcController.on('logout', () => {
    state.saved.credentials = null
    app.saveState()
  })

  ipcMain.once('ipcReady', e => {
    app.ipcReady = true
    app.emit('ipcReady')
  })

  ipcMain.on('all', (e, ...args: any[]) => {
    log.debug('Renderer event:', e, ...args)
  })

  // ipcMain.on('setAspectRatio', (e, ...args) => main.setAspectRatio(...args))
  // ipcMain.on('setBounds', (e, ...args:any[]) => main.setBounds(...args))
  ipcMain.on('setProgress', (e, progress: number) => main.setProgress(progress))
  ipcMain.on('show', () => main.show())
  // ipcMain.on('setAllowNav', (e, ...args) => menu.setAllowNav(...args))
  ipcMain.on('chooseLanguage', (e, locale: string) => {
    loadTranslations(locale)
    dcController.loginController.setCoreStrings(txCoreStrings())
    refreshMenu(logHandler)
  })

  ipcMain.once('frontendReady', () => app.emit('frontendReady'))

  /* dispatch a method on DC core */
  ipcMain.on(
    'EVENT_DC_DISPATCH',
    (e: any, identifier: number, methodName: string, args: any[]) => {
      if (!Array.isArray(args)) args = [args]
      log.debug('EVENT_DC_DISPATCH: ', methodName, args)
      dcController.callMethod(e, methodName, args)
    }
  )

  /* dispatch a method on DC core with result passed to callback */
  ipcMain.on(
    'EVENT_DC_DISPATCH_CB',
    async (e: any, identifier: number, methodName: string, args: any[]) => {
      if (!Array.isArray(args)) args = [args]
      log.debug(`EVENT_DC_DISPATCH_CB (${identifier}) : ${methodName} ${args}`)
      const returnValue = await dcController.callMethod(e, methodName, args)
      main.send(
        `EVENT_DD_DISPATCH_RETURN_${identifier}_${methodName}`,
        returnValue
      )
    }
  )

  ipcMain.on('handleLogMessage', (e, channel, level, stacktrace, ...args) =>
    logHandler.log(channel, level, stacktrace, ...args)
  )

  /** catches an Error of an async function and sends it to the frontend as event */
  const CatchError2Event = (func: Function) => {
    setTimeout(async () => {
      try {
        await func()
      } catch (error) {
        log.error(error)
        main.send('error', error.message || error)
      }
    }, 0)
  }

  ipcMain.on('login', (_e: any, credentials) => {
    CatchError2Event(() =>
      dcController.loginController.login(
        getNewAccountPath(),
        credentials,
        sendStateToRenderer,
        txCoreStrings()
      )
    )
  })

  ipcMain.on('loadAccount', (e, login: DeltaChatAccount) => {
    CatchError2Event(() =>
      dcController.loginController.login(
        login.path,
        { addr: login.addr },
        sendStateToRenderer,
        txCoreStrings()
      )
    )
  })

  const updateLogins = async () => {
    state.logins = await getLogins()
    sendStateToRenderer()
  }

  ipcMain.on('forgetLogin', async (_e: any, login: DeltaChatAccount) => {
    try {
      await removeAccount(login.path)
      main.send('success', 'successfully forgot account')
    } catch (error) {
      main.send('error', error.message)
    }
    updateLogins()
  })

  ipcMain.on('updateLogins', updateLogins)

  ipcMain.on('getMessage', (e, msgId: number) => {
    e.returnValue = dcController.messageList.messageIdToJson(msgId)
  })

  /* unused
  ipcMain.on('getChatContacts', (e, chatId) => {
    e.returnValue = dc.chat.getChatContacts(chatId)
  })
  */

  ipcMain.on('backupImport', (e, fileName) =>
    dcController.backup.import(fileName)
  )
  ipcMain.on('backupExport', (e, dir) => dcController.backup.export(dir))

  ipcMain.on('setConfig', (e, key, value) => {
    e.returnValue = dcController.settings.setConfig(key, value)
  })

  ipcMain.on('logout', () => dcController.loginController.logout())

  ipcMain.on('saveFile', (e, source, target) => {
    copyFile(source, target, err => {
      if (err) main.send('error', err.message)
    })
  })

  ipcMain.on('ondragstart', (event, filePath) => {
    event.sender.startDrag({ file: filePath, icon: null })
  })

  ipcMain.on('render', sendStateToRenderer)

  const updateDesktopSetting = (
    e: Electron.IpcMainEvent,
    key: keyof LocalSettings,
    value: string
  ) => {
    const { saved } = app.state
    ;(saved as any)[key] = value
    app.saveState({ saved })
    sendStateToRenderer()
  }
  ipcMain.on('updateDesktopSetting', updateDesktopSetting)

  ipcMain.on('saveLastChatId', (e, chatId) => {
    const { lastChats } = app.state.saved
    lastChats[dcController.credentials.addr] = chatId
    // don't save to disk, because this is already done on close and it might block
    // we can ignore the crash case, because a crash isn't supposed to happen
    // and it's not important data
  })

  ipcMain.on('getLastSelectedChatId', e => {
    const { lastChats } = app.state.saved
    e.returnValue = lastChats[dcController.credentials.addr]
  })

  ipcMain.on('selectBackgroundImage', (e, file) => {
    const copyAndSetBg = async (originalfile: string) => {
      await ensureDir(join(getConfigPath(), 'background/'))
      await emptyDir(join(getConfigPath(), 'background/'))
      const newPath = join(
        getConfigPath(),
        'background/',
        `background_${Date.now()}` + extname(originalfile)
      )
      copyFile(originalfile, newPath, (err: Error) => {
        if (err) {
          log.error('BG-IMG Copy Failed', err)
          return
        }
        updateDesktopSetting(
          null,
          'chatViewBgImg',
          `url("${newPath.replace(/\\/g, '/')}")`
        )
      })
    }
    if (!file) {
      dialog.showOpenDialog(
        undefined,
        {
          title: 'Select Background Image',
          filters: [
            { name: 'Images', extensions: ['jpg', 'png', 'gif', 'webp'] },
            { name: 'All Files', extensions: ['*'] },
          ],
          properties: ['openFile'],
        },
        (filenames: string[]) => {
          if (!filenames) {
            return
          }
          log.info('BG-IMG Selected File:', filenames[0])
          copyAndSetBg(filenames[0])
        }
      )
    } else {
      const filepath = join(__dirname, '../../images/backgrounds/', file)
      copyAndSetBg(filepath)
    }
  })

  ipcMain.on('updateCredentials', async (e, credentials) => {
    if (!credentials.mail_pw) {
      // this means another setting value was changed
      credentials.mail_pw = dcController.settings.getConfig('mail_pw')
    }
    dcController.configuring = true
    dcController.updating = true
    sendStateToRenderer()
    try {
      await dcController.loginController.configure(credentials)
    } catch (err) {
      // Ignore error & handle it in frontend
    }

    dcController.configuring = false
    main.send('success', 'Configuration success!')
    sendStateToRenderer()
  })

  ipcMain.on('cancelCredentialsUpdate', () => {
    dcController.configuring = false
    const deltachat = dcController.getState()
    sendState(deltachat)
  })

  ipcMain.on('help', async (_ev, locale) => {
    await openHelpWindow(locale)
  })

  ipcMain.on('call', async (_ev, locale, callUrl, username) => {
    await openCallWindow(locale, callUrl, username)
  })

  ipcMain.on('reload-main-window', () => {
    mainWindow.window.webContents.reload()
  })

  ipcMain.on('get-log-path', ev => {
    ev.returnValue = logHandler.logFilePath()
  })

  function sendStateToRenderer() {
    log.debug('RENDER')
    const deltachat = dcController.getState()
    main.setTitle(deltachat.credentials.addr)
    sendState(deltachat)
  }

  function sendState(deltachat: AppState['deltachat']) {
    Object.assign(state, { deltachat })
    main.send('render', state)
  }

  // if we find saved credentials we login in with these
  // which will create a new Deltachat instance which
  // is bound to a certain account
  const savedCredentials = state.saved.credentials
  if (
    savedCredentials &&
    typeof savedCredentials === 'object' &&
    Object.keys(savedCredentials).length !== 0
  ) {
    const selectedAccount = state.logins.find(
      account => account.addr === savedCredentials.addr
    )

    if (selectedAccount) {
      CatchError2Event(() =>
        dcController.loginController.login(
          selectedAccount.path,
          savedCredentials as credential_config,
          sendStateToRenderer,
          txCoreStrings()
        )
      )
    } else {
      log.error(
        'Previous account not found!',
        state.saved.credentials,
        'is not in the list of found logins:',
        state.logins
      )
    }
  }
}

function txCoreStrings() {
  const tx = app.translate
  const strings: { [key: number]: string } = {}
  // TODO: Check if we need the uncommented core translations
  strings[C.DC_STR_NOMESSAGES] = tx('chat_no_messages')
  strings[C.DC_STR_SELF] = tx('self')
  strings[C.DC_STR_DRAFT] = tx('draft')
  strings[C.DC_STR_VOICEMESSAGE] = tx('voice_message')
  strings[C.DC_STR_DEADDROP] = tx('login_inbox')
  strings[C.DC_STR_IMAGE] = tx('image')
  strings[C.DC_STR_GIF] = tx('gif')
  strings[C.DC_STR_VIDEO] = tx('video')
  strings[C.DC_STR_AUDIO] = tx('audio')
  strings[C.DC_STR_FILE] = tx('file')
  strings[C.DC_STR_ENCRYPTEDMSG] = tx('encrypted_message')
  strings[C.DC_STR_STATUSLINE] = tx('pref_default_status_text')
  strings[C.DC_STR_NEWGROUPDRAFT] = tx('group_hello_draft')
  strings[C.DC_STR_MSGGRPNAME] = tx('systemmsg_group_name_changed')
  strings[C.DC_STR_MSGGRPIMGCHANGED] = tx('systemmsg_group_image_changed')
  strings[C.DC_STR_MSGADDMEMBER] = tx('systemmsg_member_added')
  strings[C.DC_STR_MSGDELMEMBER] = tx('systemmsg_member_removed')
  strings[C.DC_STR_MSGGROUPLEFT] = tx('systemmsg_group_left')
  // strings[C.DC_STR_E2E_AVAILABLE] = tx('DC_STR_E2E_AVAILABLE')
  // strings[C.DC_STR_ENCR_TRANSP] = tx('DC_STR_ENCR_TRANSP')
  // strings[C.DC_STR_ENCR_NONE] = tx('DC_STR_ENCR_NONE')
  strings[C.DC_STR_FINGERPRINTS] = tx('qrscan_fingerprint_label')
  strings[C.DC_STR_READRCPT] = tx('systemmsg_read_receipt_subject')
  strings[C.DC_STR_READRCPT_MAILBODY] = tx('systemmsg_read_receipt_body')
  strings[C.DC_STR_MSGGRPIMGDELETED] = tx('systemmsg_group_image_deleted')
  strings[C.DC_STR_E2E_PREFERRED] = tx('autocrypt_prefer_e2ee')
  strings[C.DC_STR_ARCHIVEDCHATS] = tx('chat_archived_chats_title')
  // strings[C.DC_STR_STARREDMSGS] = tx('DC_STR_STARREDMSGS')
  strings[C.DC_STR_AC_SETUP_MSG_SUBJECT] = tx('autocrypt_asm_subject')
  strings[C.DC_STR_AC_SETUP_MSG_BODY] = tx('autocrypt_asm_general_body')
  strings[C.DC_STR_CANTDECRYPT_MSG_BODY] = tx('systemmsg_cannot_decrypt')
  strings[C.DC_STR_CANNOT_LOGIN] = tx('login_error_cannot_login')
  strings[C.DC_STR_SERVER_RESPONSE] = tx('login_error_server_response')
  strings[68] = tx('device_talk')
  strings[69] = tx('saved_messages')

  return strings
}
