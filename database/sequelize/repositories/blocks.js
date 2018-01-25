const Op = require('sequelize').Op
const moment = require('moment')
const buildFilterQuery = require('../utils/filter-query')

class BlocksRepository {
  constructor (db) {
    this.db = db
  }

  all (queryParams) {
      let whereStatement = {}
      let orderBy = []

      const filter = ['generatorPublicKey', 'totalAmount', 'totalFee', 'reward', 'previousBlock', 'height']
      for (const elem of filter) {
        if (queryParams[elem]) whereStatement[elem] = queryParams[elem]
      }

      if (queryParams.orderBy) orderBy.push(queryParams.orderBy.split(':'))
console.log(queryParams)
      return this.db.blocksTable.findAndCountAll({
        where: whereStatement,
        order: orderBy,
        offset: queryParams.offset,
        limit: queryParams.limit
      })
  }

  paginate (pager, queryParams = {}) {
    let offset = (pager.page > 1) ? pager.page * pager.perPage : 0

    return this.all(Object.assign(queryParams, { offset, limit: pager.perPage }))
  }

  paginateByGenerator (generatorPublicKey, pager) {
    return this.paginate(pager, { where: { generatorPublicKey } })
  }

  findById (id) {
    return this.db.blocksTable.findById(id)
  }

  findLastByPublicKey (generatorPublicKey) {
    return this.db.blocksTable.findOne({
      limit: 1,
      where: { generatorPublicKey },
      order: [[ 'createdAt', 'DESC' ]]
    })
  }

  allByDateTimeRange (from, to) {
    return this.db.blocksTable.findAndCountAll({
      attributes: ['totalFee', 'reward'],
      where: {
        createdAt: {
          [Op.lte]: moment(to).endOf('day').toDate(),
          [Op.gte]: moment(from).startOf('day').toDate()
        }
      }
    })
  }

  search (params) {
    return this.db.blocksTable.findAndCountAll({
      where: buildFilterQuery(params, {
        exact: ['id', 'version', 'previousBlock', 'payloadHash', 'generatorPublicKey', 'blockSignature'],
        between: ['timestamp', 'height', 'numberOfTransactions', 'totalAmount', 'totalFee', 'reward', 'payloadLength']
      })
    })
  }
}

module.exports = BlocksRepository
