import * as express from 'express'
import { body, param, query, ValidationChain } from 'express-validator/check'
import { UserRight, VideoPlaylistCreate, VideoPlaylistUpdate } from '../../../../shared'
import { logger } from '../../../helpers/logger'
import { UserModel } from '../../../models/account/user'
import { areValidationErrors } from '../utils'
import { doesVideoExist, isVideoImage } from '../../../helpers/custom-validators/videos'
import { CONSTRAINTS_FIELDS } from '../../../initializers/constants'
import { isArrayOf, isIdOrUUIDValid, isIdValid, isUUIDValid, toIntArray, toValueOrNull } from '../../../helpers/custom-validators/misc'
import {
  doesVideoPlaylistExist,
  isVideoPlaylistDescriptionValid,
  isVideoPlaylistNameValid,
  isVideoPlaylistPrivacyValid,
  isVideoPlaylistTimestampValid,
  isVideoPlaylistTypeValid
} from '../../../helpers/custom-validators/video-playlists'
import { VideoPlaylistModel } from '../../../models/video/video-playlist'
import { cleanUpReqFiles } from '../../../helpers/express-utils'
import { doesVideoChannelIdExist } from '../../../helpers/custom-validators/video-channels'
import { VideoPlaylistElementModel } from '../../../models/video/video-playlist-element'
import { authenticatePromiseIfNeeded } from '../../oauth'
import { VideoPlaylistPrivacy } from '../../../../shared/models/videos/playlist/video-playlist-privacy.model'
import { VideoPlaylistType } from '../../../../shared/models/videos/playlist/video-playlist-type.model'

const videoPlaylistsAddValidator = getCommonPlaylistEditAttributes().concat([
  async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.debug('Checking videoPlaylistsAddValidator parameters', { parameters: req.body })

    if (areValidationErrors(req, res)) return cleanUpReqFiles(req)

    const body: VideoPlaylistCreate = req.body
    if (body.videoChannelId && !await doesVideoChannelIdExist(body.videoChannelId, res)) return cleanUpReqFiles(req)

    if (body.privacy === VideoPlaylistPrivacy.PUBLIC && !body.videoChannelId) {
      cleanUpReqFiles(req)
      return res.status(400)
                .json({ error: 'Cannot set "public" a playlist that is not assigned to a channel.' })
    }

    return next()
  }
])

const videoPlaylistsUpdateValidator = getCommonPlaylistEditAttributes().concat([
  param('playlistId')
    .custom(isIdOrUUIDValid).withMessage('Should have a valid playlist id/uuid'),

  async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.debug('Checking videoPlaylistsUpdateValidator parameters', { parameters: req.body })

    if (areValidationErrors(req, res)) return cleanUpReqFiles(req)

    if (!await doesVideoPlaylistExist(req.params.playlistId, res, 'all')) return cleanUpReqFiles(req)

    const videoPlaylist = res.locals.videoPlaylist

    if (!checkUserCanManageVideoPlaylist(res.locals.oauth.token.User, res.locals.videoPlaylist, UserRight.REMOVE_ANY_VIDEO_PLAYLIST, res)) {
      return cleanUpReqFiles(req)
    }

    const body: VideoPlaylistUpdate = req.body

    if (videoPlaylist.privacy !== VideoPlaylistPrivacy.PRIVATE && body.privacy === VideoPlaylistPrivacy.PRIVATE) {
      cleanUpReqFiles(req)
      return res.status(400)
                .json({ error: 'Cannot set "private" a video playlist that was not private.' })
    }

    const newPrivacy = body.privacy || videoPlaylist.privacy
    if (newPrivacy === VideoPlaylistPrivacy.PUBLIC &&
      (
        (!videoPlaylist.videoChannelId && !body.videoChannelId) ||
        body.videoChannelId === null
      )
    ) {
      cleanUpReqFiles(req)
      return res.status(400)
                .json({ error: 'Cannot set "public" a playlist that is not assigned to a channel.' })
    }

    if (videoPlaylist.type === VideoPlaylistType.WATCH_LATER) {
      cleanUpReqFiles(req)
      return res.status(400)
                .json({ error: 'Cannot update a watch later playlist.' })
    }

    if (body.videoChannelId && !await doesVideoChannelIdExist(body.videoChannelId, res)) return cleanUpReqFiles(req)

    return next()
  }
])

const videoPlaylistsDeleteValidator = [
  param('playlistId')
    .custom(isIdOrUUIDValid).withMessage('Should have a valid playlist id/uuid'),

  async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.debug('Checking videoPlaylistsDeleteValidator parameters', { parameters: req.params })

    if (areValidationErrors(req, res)) return

    if (!await doesVideoPlaylistExist(req.params.playlistId, res)) return

    const videoPlaylist = res.locals.videoPlaylist
    if (videoPlaylist.type === VideoPlaylistType.WATCH_LATER) {
      return res.status(400)
                .json({ error: 'Cannot delete a watch later playlist.' })
    }

    if (!checkUserCanManageVideoPlaylist(res.locals.oauth.token.User, res.locals.videoPlaylist, UserRight.REMOVE_ANY_VIDEO_PLAYLIST, res)) {
      return
    }

    return next()
  }
]

const videoPlaylistsGetValidator = [
  param('playlistId')
    .custom(isIdOrUUIDValid).withMessage('Should have a valid playlist id/uuid'),

  async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.debug('Checking videoPlaylistsGetValidator parameters', { parameters: req.params })

    if (areValidationErrors(req, res)) return

    if (!await doesVideoPlaylistExist(req.params.playlistId, res)) return

    const videoPlaylist = res.locals.videoPlaylist

    // Video is unlisted, check we used the uuid to fetch it
    if (videoPlaylist.privacy === VideoPlaylistPrivacy.UNLISTED) {
      if (isUUIDValid(req.params.playlistId)) return next()

      return res.status(404).end()
    }

    if (videoPlaylist.privacy === VideoPlaylistPrivacy.PRIVATE) {
      await authenticatePromiseIfNeeded(req, res)

      const user = res.locals.oauth ? res.locals.oauth.token.User : null

      if (
        !user ||
        (videoPlaylist.OwnerAccount.id !== user.Account.id && !user.hasRight(UserRight.UPDATE_ANY_VIDEO_PLAYLIST))
      ) {
        return res.status(403)
                  .json({ error: 'Cannot get this private video playlist.' })
      }

      return next()
    }

    return next()
  }
]

const videoPlaylistsAddVideoValidator = [
  param('playlistId')
    .custom(isIdOrUUIDValid).withMessage('Should have a valid playlist id/uuid'),
  body('videoId')
    .custom(isIdOrUUIDValid).withMessage('Should have a valid video id/uuid'),
  body('startTimestamp')
    .optional()
    .custom(isVideoPlaylistTimestampValid).withMessage('Should have a valid start timestamp'),
  body('stopTimestamp')
    .optional()
    .custom(isVideoPlaylistTimestampValid).withMessage('Should have a valid stop timestamp'),

  async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.debug('Checking videoPlaylistsAddVideoValidator parameters', { parameters: req.params })

    if (areValidationErrors(req, res)) return

    if (!await doesVideoPlaylistExist(req.params.playlistId, res, 'all')) return
    if (!await doesVideoExist(req.body.videoId, res, 'only-video')) return

    const videoPlaylist = res.locals.videoPlaylist
    const video = res.locals.video

    const videoPlaylistElement = await VideoPlaylistElementModel.loadByPlaylistAndVideo(videoPlaylist.id, video.id)
    if (videoPlaylistElement) {
      res.status(409)
         .json({ error: 'This video in this playlist already exists' })
         .end()

      return
    }

    if (!checkUserCanManageVideoPlaylist(res.locals.oauth.token.User, res.locals.videoPlaylist, UserRight.UPDATE_ANY_VIDEO_PLAYLIST, res)) {
      return
    }

    return next()
  }
]

const videoPlaylistsUpdateOrRemoveVideoValidator = [
  param('playlistId')
    .custom(isIdOrUUIDValid).withMessage('Should have a valid playlist id/uuid'),
  param('videoId')
    .custom(isIdOrUUIDValid).withMessage('Should have an video id/uuid'),
  body('startTimestamp')
    .optional()
    .custom(isVideoPlaylistTimestampValid).withMessage('Should have a valid start timestamp'),
  body('stopTimestamp')
    .optional()
    .custom(isVideoPlaylistTimestampValid).withMessage('Should have a valid stop timestamp'),

  async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.debug('Checking videoPlaylistsRemoveVideoValidator parameters', { parameters: req.params })

    if (areValidationErrors(req, res)) return

    if (!await doesVideoPlaylistExist(req.params.playlistId, res, 'all')) return
    if (!await doesVideoExist(req.params.videoId, res, 'id')) return

    const videoPlaylist = res.locals.videoPlaylist
    const video = res.locals.video

    const videoPlaylistElement = await VideoPlaylistElementModel.loadByPlaylistAndVideo(videoPlaylist.id, video.id)
    if (!videoPlaylistElement) {
      res.status(404)
         .json({ error: 'Video playlist element not found' })
         .end()

      return
    }
    res.locals.videoPlaylistElement = videoPlaylistElement

    if (!checkUserCanManageVideoPlaylist(res.locals.oauth.token.User, videoPlaylist, UserRight.UPDATE_ANY_VIDEO_PLAYLIST, res)) return

    return next()
  }
]

const videoPlaylistElementAPGetValidator = [
  param('playlistId')
    .custom(isIdOrUUIDValid).withMessage('Should have a valid playlist id/uuid'),
  param('videoId')
    .custom(isIdOrUUIDValid).withMessage('Should have an video id/uuid'),

  async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.debug('Checking videoPlaylistElementAPGetValidator parameters', { parameters: req.params })

    if (areValidationErrors(req, res)) return

    const videoPlaylistElement = await VideoPlaylistElementModel.loadByPlaylistAndVideoForAP(req.params.playlistId, req.params.videoId)
    if (!videoPlaylistElement) {
      res.status(404)
         .json({ error: 'Video playlist element not found' })
         .end()

      return
    }

    if (videoPlaylistElement.VideoPlaylist.privacy === VideoPlaylistPrivacy.PRIVATE) {
      return res.status(403).end()
    }

    res.locals.videoPlaylistElement = videoPlaylistElement

    return next()
  }
]

const videoPlaylistsReorderVideosValidator = [
  param('playlistId')
    .custom(isIdOrUUIDValid).withMessage('Should have a valid playlist id/uuid'),
  body('startPosition')
    .isInt({ min: 1 }).withMessage('Should have a valid start position'),
  body('insertAfterPosition')
    .isInt({ min: 0 }).withMessage('Should have a valid insert after position'),
  body('reorderLength')
    .optional()
    .isInt({ min: 1 }).withMessage('Should have a valid range length'),

  async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.debug('Checking videoPlaylistsReorderVideosValidator parameters', { parameters: req.params })

    if (areValidationErrors(req, res)) return

    if (!await doesVideoPlaylistExist(req.params.playlistId, res, 'all')) return

    const videoPlaylist = res.locals.videoPlaylist
    if (!checkUserCanManageVideoPlaylist(res.locals.oauth.token.User, videoPlaylist, UserRight.UPDATE_ANY_VIDEO_PLAYLIST, res)) return

    const nextPosition = await VideoPlaylistElementModel.getNextPositionOf(videoPlaylist.id)
    const startPosition: number = req.body.startPosition
    const insertAfterPosition: number = req.body.insertAfterPosition
    const reorderLength: number = req.body.reorderLength

    if (startPosition >= nextPosition || insertAfterPosition >= nextPosition) {
      res.status(400)
         .json({ error: `Start position or insert after position exceed the playlist limits (max: ${nextPosition - 1})` })
         .end()

      return
    }

    if (reorderLength && reorderLength + startPosition > nextPosition) {
      res.status(400)
         .json({ error: `Reorder length with this start position exceeds the playlist limits (max: ${nextPosition - startPosition})` })
         .end()

      return
    }

    return next()
  }
]

const commonVideoPlaylistFiltersValidator = [
  query('playlistType')
    .optional()
    .custom(isVideoPlaylistTypeValid).withMessage('Should have a valid playlist type'),

  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.debug('Checking commonVideoPlaylistFiltersValidator parameters', { parameters: req.params })

    if (areValidationErrors(req, res)) return

    return next()
  }
]

const doVideosInPlaylistExistValidator = [
  query('videoIds')
    .customSanitizer(toIntArray)
    .custom(v => isArrayOf(v, isIdValid)).withMessage('Should have a valid video ids array'),

  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.debug('Checking areVideosInPlaylistExistValidator parameters', { parameters: req.query })

    if (areValidationErrors(req, res)) return

    return next()
  }
]

// ---------------------------------------------------------------------------

export {
  videoPlaylistsAddValidator,
  videoPlaylistsUpdateValidator,
  videoPlaylistsDeleteValidator,
  videoPlaylistsGetValidator,

  videoPlaylistsAddVideoValidator,
  videoPlaylistsUpdateOrRemoveVideoValidator,
  videoPlaylistsReorderVideosValidator,

  videoPlaylistElementAPGetValidator,

  commonVideoPlaylistFiltersValidator,

  doVideosInPlaylistExistValidator
}

// ---------------------------------------------------------------------------

function getCommonPlaylistEditAttributes () {
  return [
    body('thumbnailfile')
      .custom((value, { req }) => isVideoImage(req.files, 'thumbnailfile')).withMessage(
      'This thumbnail file is not supported or too large. Please, make sure it is of the following type: '
      + CONSTRAINTS_FIELDS.VIDEO_PLAYLISTS.IMAGE.EXTNAME.join(', ')
    ),

    body('displayName')
      .custom(isVideoPlaylistNameValid).withMessage('Should have a valid display name'),
    body('description')
      .optional()
      .customSanitizer(toValueOrNull)
      .custom(isVideoPlaylistDescriptionValid).withMessage('Should have a valid description'),
    body('privacy')
      .optional()
      .toInt()
      .custom(isVideoPlaylistPrivacyValid).withMessage('Should have correct playlist privacy'),
    body('videoChannelId')
      .optional()
      .customSanitizer(toValueOrNull)
      .toInt()
  ] as (ValidationChain | express.Handler)[]
}

function checkUserCanManageVideoPlaylist (user: UserModel, videoPlaylist: VideoPlaylistModel, right: UserRight, res: express.Response) {
  if (videoPlaylist.isOwned() === false) {
    res.status(403)
       .json({ error: 'Cannot manage video playlist of another server.' })
       .end()

    return false
  }

  // Check if the user can manage the video playlist
  // The user can delete it if s/he is an admin
  // Or if s/he is the video playlist's owner
  if (user.hasRight(right) === false && videoPlaylist.ownerAccountId !== user.Account.id) {
    res.status(403)
       .json({ error: 'Cannot manage video playlist of another user' })
       .end()

    return false
  }

  return true
}
