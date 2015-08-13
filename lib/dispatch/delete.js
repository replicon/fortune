import clone from 'clone'
import change from '../common/change'
import * as methods from '../common/methods'
import * as keys from '../common/keys'
import { BadRequestError, NotFoundError } from '../common/errors'
import * as updateHelpers from './update_helpers'


/**
 * Delete records. This does not mutate context.
 *
 * @return {Promise}
 */
export default function (context) {
  const { type, ids, options } = context.request
  const { adapter, recordTypes, transforms } = this
  const updates = {}
  let transaction
  let records

  if (!ids.length) throw new BadRequestError(
    `No IDs were specified to be deleted.`)

  const fields = recordTypes[type]
  const transform = transforms[type]
  const links = Object.keys(fields)
    .filter(field => keys.link in fields[field])

  return adapter.find(type, ids, options)

  .then(foundRecords => {
    records = foundRecords

    if (!records.length)
      throw new NotFoundError(
        `There are no records to be deleted.`)

    Object.defineProperty(context.response, 'records', {
      configurable: true,
      value: records
    })

    return transform && transform.input ? Promise.all(records.map(record =>
      transform.input(context, clone(record)))) : records
  })

  .then(() => adapter.beginTransaction())

  .then(t => {
    transaction = t
    return transaction.delete(type, ids, options)
  })

  .then(() => {
    // Remove all instances of the deleted IDs in all records.
    const idCache = {}

    // Loop over each record to generate updates object.
    for (let record of records)
      for (let field of links) {
        const inverseField = fields[field][keys.inverse]

        if (!(field in record) || !inverseField) continue

        const linkedType = fields[field][keys.link]
        const linkedIsArray =
          recordTypes[linkedType][inverseField][keys.isArray]
        const linkedIds = Array.isArray(record[field]) ?
          record[field] : [ record[field] ]

        // Do some initialization.
        if (!(linkedType in updates)) updates[linkedType] = []
        if (!(linkedType in idCache)) idCache[linkedType] = new Set()

        for (let id of linkedIds)
          if (id !== null)
          updateHelpers.removeId(record[keys.primary],
            updateHelpers.getUpdate(linkedType, id, updates, idCache),
            inverseField, linkedIsArray)
      }

    return Promise.all(Object.keys(updates)
      .map(type => updates[type].length ?
        transaction.update(type, updates[type]) :
        Promise.resolve([])))
  })

  .then(() => transaction.endTransaction())

  .catch(error => {
    if (transaction) transaction.endTransaction(error)
    throw error
  })

  .then(() => {
    const mapId = update => update[keys.primary]

    const eventData = {
      [methods.delete]: { [type]: ids }
    }

    for (let type of Object.keys(updates)) {
      if (!updates[type].length) continue
      if (!(methods.update in eventData)) eventData[methods.update] = {}
      eventData[methods.update][type] = updates[type].map(mapId)
    }

    // Summarize changes during the lifecycle of the request.
    this.emit(change, eventData)

    return context
  })
}
