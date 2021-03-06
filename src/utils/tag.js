'use strict'
const _ = require('lodash')
const Client = require('./fc/client')

class TAG extends Client {
  constructor (credentials, region) {
    super(credentials, region)
    this.fcClient = this.buildFcClient()
  }

  /**
   * Remove tags
   * @param {*} resourceArn
   * @param {*} tags : Will delete all tags if not specified
   */
  async remove (resourceArn, parameters) {
    const onlyRemoveTagName = parameters ? (parameters.k || parameters.key) : false
    const tagKeys = []

    if (onlyRemoveTagName) {
      tagKeys.push(onlyRemoveTagName)
    } else {
      try {
        const allTags = await this.fcClient.getResourceTags({ resourceArn: resourceArn })
        if (allTags.data && allTags.data.tags) {
          const tagsAttr = allTags.data.tags
          for (const key in tagsAttr) {
            tagKeys.push(key)
          }
        }
      } catch (ex) {
        throw new Error(`Unable to get tags: ${ex.message}`)
      }
    }
    if (tagKeys.length !== 0) {
      console.log('Tags: untag resource: ', tagKeys)
      await this.fcClient.untagResource(resourceArn, tagKeys)
      console.log('Tags: untag resource successfully: ', tagKeys)
    } else {
      console.log('tags length is 0, skip deleting.')
    }
  }

  async deploy (resourceArn, tagsInput, tagName) {
    if (_.isEmpty(tagsInput)) { return }
    let tags = {}
    // tags格式化
    tagsInput.forEach(({ Key, Value }) => {
      if (Key !== undefined) {
        tags[Key] = Value
      }
    })
    if (tagName) {
      if (!_.has(tags, tagName)) {
        throw new Error(`${tagName} not found.`)
      }
      tags = {
        [tagName]: tags[tagName]
      }
    }

    // let tagsAttr
    // try {
    //   const tempTags = await this.fcClient.getResourceTags({ resourceArn: resourceArn })
    //   tagsAttr = tempTags.data.tags
    // } catch (ex) {
    //   tagsAttr = {}
    // }

    // 删除标签
    // const untagResourceKeys = []
    // for (const item in tagsAttr) {
    //   if (!(_.has(tags, item) && tags[item] === tagsAttr[item])) {
    //     untagResourceKeys.push(item)
    //   }
    // }
    // if (untagResourceKeys.length > 0) {
    //   console.log('Tags: untag resource: ', untagResourceKeys)
    //   await this.fcClient.untagResource(resourceArn, untagResourceKeys)
    // }

    // 打标签
    console.log('Tags: tagging resource ...')
    await this.fcClient.tagResource(resourceArn, tags)

    return tags
  }
}

module.exports = TAG
