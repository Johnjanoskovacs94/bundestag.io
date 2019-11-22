/* eslint-disable no-mixed-operators */

import _ from 'lodash';
import Scraper from '@democracy-deutschland/dip21-scraper';
import prettyMs from 'pretty-ms';
import moment from 'moment';

import CONFIG from './../config';
import PROCEDURE_STATES from './../config/procedureStates';

import Procedure from './../models/Procedure';
import CronJobModel from './../models/CronJob';

const scraper = new Scraper();
let pastScrapeData = null; // eslint-disable-line
// const procedureStatusWhitelist = [
//   "Überwiesen",
//   "Beschlussempfehlung liegt vor"
// ];
let cronIsRunning = false;
let cronStart = null;

const parseDate = input => {
  const parts = input.match(/(\d+)/g);
  // note parts[1]-1
  return new Date(Date.UTC(parts[2], parts[1] - 1, parts[0]));
};

const ensureArray = element => {
  if (element) {
    if (!_.isArray(element)) {
      return [element];
    }
    return element;
  }
  return null;
};

const saveProcedure = async ({ procedureData }) => {
  const process = _.isArray(procedureData.VORGANGSABLAUF.VORGANGSPOSITION)
    ? procedureData.VORGANGSABLAUF.VORGANGSPOSITION
    : [procedureData.VORGANGSABLAUF.VORGANGSPOSITION];
  const history = process.map(e => {
    const flow = {
      assignment: e.ZUORDNUNG.trim(),
      initiator: e.URHEBER.trim(),
      findSpot: e.FUNDSTELLE.trim(),
      findSpotUrl: _.trim(e.FUNDSTELLE_LINK),
      date: parseDate(e.FUNDSTELLE.substr(0, 10)),
    };
    if (e.VP_ABSTRAKT) {
      flow.abstract = e.VP_ABSTRAKT.trim();
    }
    if (e.BESCHLUSS) {
      if (!_.isArray(e.BESCHLUSS)) {
        e.BESCHLUSS = [e.BESCHLUSS];
      }
      if (e.BESCHLUSS.length > 0) {
        flow.decision = e.BESCHLUSS.map(beschluss => ({
          page: beschluss.BESCHLUSSSEITE || undefined,
          tenor: beschluss.BESCHLUSSTENOR || undefined,
          document: beschluss.BEZUGSDOKUMENT || undefined,
          type: beschluss.ABSTIMMUNGSART || undefined,
          comment: beschluss.ABSTIMMUNG_BEMERKUNG || undefined,
          majority: beschluss.MEHRHEIT || undefined,
          foundation: beschluss.GRUNDLAGE || undefined,
        }));
      }
    }
    return flow;
  });

  /* let approvalRequired;
  if (procedureData.VORGANG.ZUSTIMMUNGSBEDUERFTIGKEIT) {
    if (!_.isArray(procedureData.VORGANG.ZUSTIMMUNGSBEDUERFTIGKEIT)) {
      approvalRequired = [procedureData.VORGANG.ZUSTIMMUNGSBEDUERFTIGKEIT];
    } else {
      approvalRequired = procedureData.VORGANG.ZUSTIMMUNGSBEDUERFTIGKEIT;
    }
  } */

  const procedureObj = {
    procedureId: procedureData.vorgangId || undefined,
    type: procedureData.VORGANG.VORGANGSTYP || undefined,
    period: parseInt(procedureData.VORGANG.WAHLPERIODE, 10) || undefined,
    title: procedureData.VORGANG.TITEL || undefined,
    currentStatus: procedureData.VORGANG.AKTUELLER_STAND || undefined,
    signature: procedureData.VORGANG.SIGNATUR || undefined,
    gestOrderNumber: procedureData.VORGANG.GESTA_ORDNUNGSNUMMER || undefined,
    approvalRequired: ensureArray(procedureData.VORGANG.ZUSTIMMUNGSBEDUERFTIGKEIT),
    euDocNr: procedureData.VORGANG.EU_DOK_NR || undefined,
    abstract: procedureData.VORGANG.ABSTRAKT || undefined,
    promulgation: ensureArray(procedureData.VORGANG.VERKUENDUNG),
    legalValidity: ensureArray(procedureData.VORGANG.INKRAFTTRETEN),
    tags: ensureArray(procedureData.VORGANG.SCHLAGWORT),
    subjectGroups: ensureArray(procedureData.VORGANG.SACHGEBIET),
    importantDocuments: ensureArray(procedureData.VORGANG.WICHTIGE_DRUCKSACHE || []).map(doc => ({
      editor: doc.DRS_HERAUSGEBER,
      number: doc.DRS_NUMMER,
      type: doc.DRS_TYP,
      url: doc.DRS_LINK,
    })),
    history,
  };

  await Procedure.update(
    {
      procedureId: procedureObj.procedureId,
    },
    { $set: _.pickBy(procedureObj) },
    {
      upsert: true,
    },
  );
};

// const doScrape = ({ data }) => {
//   const parts = data.date.match(/(\d+)/g);
//   const dipDate = new Date(Date.UTC(parts[2], parts[1] - 1, parts[0]));

//   let scrapeData = pastScrapeData.find(
//     ({ procedureId }) => procedureId === data.id
//   );
//   if (!scrapeData) {
//     scrapeData = { updatedAt: 0 };
//   }
//   const scrapeDate = new Date(scrapeData.updatedAt);

//   const timeSpanDib = new Date() - dipDate;
//   const timeSpanScrape = new Date() - scrapeDate;

//   const oneDay = 1000 * 60 * 60 * 24;
//   const oneWeek = oneDay * 7;
//   const oneMonth = oneDay * 31;
//   const oneYear = oneDay * 365;

//   // TIME SCRAPE
//   if (
//     // always scrape when dib_date is after last scrape_date
//     dipDate > scrapeDate ||
//     // always scrape last 3 Months
//     timeSpanDib < 3 * oneMonth ||
//     // always scrape when last scrape_date is one month old
//     timeSpanScrape > oneMonth ||
//     // always scrape when last scrape_date is one day old and dib is up to 1 year old
//     (timeSpanScrape > oneDay && timeSpanDib < oneYear) ||
//     // always scrape when last scrape_date is one week old and dib is up to 4 year old
//     (timeSpanScrape > oneWeek && timeSpanDib < 4 * oneYear)
//   ) {
//     return true;
//   }

//   // STATUS SCRAPE -> Whitelist
//   if (
//     procedureStatusWhitelist.find(white => white === scrapeData.currentStatus)
//   ) {
//     return true;
//   }

//   return false;
// };

let linksSum = 0;
let startDate;

/* const logUpdateSearchProgress = ({ hasError }) => {
  process.stdout.write(hasError ? 'e' : '.');
}; */

const logStartDataProgress = async ({ sum }) => {
  startDate = new Date();
  // process.stdout.write('\n');
  linksSum = sum;
  Log.info(`STARTED PROCEDURE DATA SCRAPER - ${startDate} - ${linksSum} Links found`);
};

/* const logUpdateDataProgress = ({ hasError }) => {
  process.stdout.write(hasError ? 'e' : '.');
}; */

const logFinished = () => {
  const end = Date.now();
  const elapsed = end - cronStart;
  Log.info(`FINISHED PROCEDURE SCRAPER - ${prettyMs(_.toInteger(elapsed))}`);
  cronIsRunning = false;
};

const logError = ({ error }) => {
  Log.error(error);
};

const cronTask = async () => {
  if (!cronIsRunning) {
    cronIsRunning = true;
    cronStart = Date.now();
    await CronJobModel.findOneAndUpdate(
      {
        name: 'import-procedures',
      },
      {
        $set: {
          name: 'import-procedures',
          lastStartDate: cronStart,
        },
      },
      {
        upsert: true,
        new: true,
      },
    );
    Log.info(`STARTED PROCEDURE SCRAPER - ${moment(cronStart).format()}`);
    // get old Scrape Data for cache
    pastScrapeData = await Procedure.find({}, { procedureId: 1, updatedAt: 1, currentStatus: 1 });
    // Do the scrape
    await scraper
      .scrape({
        // settings
        browserStackSize: 5,
        selectPeriods: CONFIG.PERIODS,
        selectOperationTypes: ['100', '500'],
        logUpdateSearchProgress: () => {},
        logStartDataProgress,
        logStopDataProgress: () => {} /* () => {
          process.stdout.write('\n');
        } */,
        logUpdateDataProgress: () => {},
        // log
        logFinished,
        logError,
        // data
        outScraperData: saveProcedure,
        // cache(link skip logic)
        // doScrape
        type: 'html',
        liveScrapeStates: PROCEDURE_STATES.IN_VOTE,
      })
      .then(async () => {
        await CronJobModel.update(
          {
            name: 'import-procedures',
          },
          {
            $set: {
              lastFinishDate: Date.now(),
            },
          },
          {
            upsert: true,
          },
        );

        Log.info('#####FINISH####');
      })
      .catch(async error => {
        Log.error(error);
        logFinished();
        await CronJobModel.update(
          {
            name: 'import-procedures',
          },
          {
            $set: {
              lastErrorDate: Date.now(),
            },
          },
          {
            upsert: true,
          },
        );
      });
  }
};

export default cronTask;
