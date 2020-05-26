import React, { useState, useEffect } from 'react'
import DeltaDialog, { DeltaDialogBody, DeltaDialogFooter, DeltaDialogContent } from './DeltaDialog'
import { Classes } from '@blueprintjs/core'
import { DeltaBackend } from '../../delta-remote'
import { FullChat } from '../../../shared/shared-types'

export default function EphemeralMessage ({
  onClose,
  isOpen,
  selectedChat
}: {
  onClose: () => void
  isOpen: boolean
  selectedChat: FullChat
}) {
  const chatId = selectedChat.id
  const tx = window.translate

  const options = [
    [0, 'off', 'Off'],
    [1, 'one_second', 'One second'],
    [60, 'one_minute', 'One minute'],
    [60*60, 'one_hour', 'One hour'],
    [24*60*60,'one_day', 'One day'],
    [7*24*60*60, 'one_week', 'One week'],
    [31*7*24*60*60, 'one_month', 'One month']
  ]

  const [autodeleteTimer, setAutodeleteTimer] = useState(-1)

  const onClickOk = async () => {
    await DeltaBackend.call('chat.setChatAutodeleteTimer', chatId, autodeleteTimer)
    onClose()
  }

  useEffect(() => {
    (async () => {
      const autodeleteTimer = await DeltaBackend.call('chat.getChatAutodeleteTimer', chatId)
      setAutodeleteTimer(autodeleteTimer)
    })()
  }, [])

  return (
    <DeltaDialog
      isOpen={isOpen}
      title='Ephemeral Message' // TODO: Translate
      onClose={onClose}
    >
      <DeltaDialogBody>
        <DeltaDialogContent noPadding>
          <ul className='ephemeral-message__select-option'>
            {options.map(([timer, key, text]) => {
              return (
                <li key={`option-${key}`} className={autodeleteTimer === timer ? 'active' : ''} onClick={() => setAutodeleteTimer(timer as number)}>{text}</li>
              )
            })}
          </ul>
        </DeltaDialogContent>
      </DeltaDialogBody>
      <DeltaDialogFooter>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <p className='delta-button primary'>
            {tx('ok')}
          </p>
        </div>
      </DeltaDialogFooter>
    </DeltaDialog>
  )
}
