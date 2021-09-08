// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from 'next';
import { Method } from 'axios';
import cheerio from 'cheerio';
import psl from 'psl';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import api from '../../../lib/api';
import { extractHostname, isString, isValidWebUrl } from '../../../utils';

type apiData = {
  success: boolean,
  result?: any,
  error?: any,
  errors?: Array<any>
}

const handler = async (req: NextApiRequest, res: NextApiResponse<apiData>) => {
  const { url } = req.query;
  if (isString(url)) {
    const targetUrl = decodeURIComponent(Buffer.from(url, 'base64').toString());
    if (isValidWebUrl(targetUrl)) {
      switch (req.method) {
        case 'GET':
          // Get images for root domain
          let rootDomainImageUrls:Array<string> = [];
          let imageSearchString:string = "";
          let errors:Array<any> = [];
          const rootDomain = psl.get(extractHostname(targetUrl));
          if (rootDomain) {
            const parsed = psl.parse(rootDomain);
            if (!parsed.error) {
              if (parsed.sld) {
                imageSearchString = parsed.sld;
                const imageSearch = await getBingImageSearch(imageSearchString);
                if (imageSearch.results) {
                  rootDomainImageUrls = imageSearch.results.map((imageResult: { contentUrl: string; }) => imageResult.contentUrl)
                } else {
                  errors.push(imageSearch.error);
                }
              } else {
                throw Error("sld not found");
              }
            } else {
              throw Error(JSON.stringify(parsed.error));
            }
          } else {
            throw Error("Root domain not found");
          }
        
          // Get images specific to given url
          const tags = await scrapeMetaTags(targetUrl);
        
          if (tags.data) {
            if (/\S/.test(tags.data.title)) {
              imageSearchString = getImageSearchString(tags.data.title, tags.data.url, tags.data.siteName);
              const imageSearch = await getBingImageSearch(imageSearchString);
              if (imageSearch.results) { 
                const imageUrls = imageSearch.results.map((imageResult: { contentUrl: string; }) => imageResult.contentUrl);
                // Add in some of the root domain images
                imageUrls.splice(2, 0, rootDomainImageUrls[0]);
                imageUrls.splice(5, 0, rootDomainImageUrls[1]);
                imageUrls.splice(10, 0, rootDomainImageUrls[2]);
                imageUrls.splice(15, 0, rootDomainImageUrls[3]);
                imageUrls.splice(20, 0, rootDomainImageUrls[4]);
                return res.status(200).json({
                  result: {
                    metaTags: tags.data,
                    imageSearch: imageSearchString,
                    imageResults: imageUrls
                  },
                  success: true
                })
              } else {
                // Fallback to just show root domain images if they exist and any errors
                errors.push(imageSearch.error);
                return res.status(200).json({
                  errors: errors,
                  success: true,
                  result: {
                    metaTags: tags.data,
                    imageSearch: imageSearchString,
                    imageResults: rootDomainImageUrls
                  }
                });
              }
            } else {
              // Fallback to just show root domain images if they exist and any errors
              return res.status(200).json({
                errors: errors,
                success: true,
                result: {
                  metaTags: tags.data,
                  imageSearch: imageSearchString,
                  imageResults: rootDomainImageUrls
                }
              });
            }
          } else {
            // Fallback to just show root domain images if they exist and any errors
            errors.push(tags.errors);
            return res.status(200).json({
              errors: errors,
              success: true,
              result: {
                imageSearch: imageSearchString,
                imageResults: rootDomainImageUrls
              }
            });
          }

        default:
          return res.status(404).json({ success: false, error: `Method ${req.method} not allowed` });
      }
    } else {
      return res.status(400).json({ success: false, error: 'Invalid web url' });
    }
  } else {
    return res.status(400).json({ success: false, error: 'Only one url can be checked' });
  }
}

const getImageSearchString = (title: string, url: string, siteName?: string) => {
  
  const rootDomain = psl.get(extractHostname(url));
  let searchString = title;
  if (rootDomain) {
    const domainSearchMask = rootDomain;
    const domainRegEx = new RegExp(domainSearchMask, 'ig'); 
    const stripRootDomain = title.replace(domainRegEx, '');
    if (/\S/.test(stripRootDomain)) {
      searchString = stripRootDomain;
    }
  }

  // Can remove site name here for more specificity but generally leads to worse results
  // const siteNameSearchMask = siteName ? siteName : '';
  // const siteNameRegEx = new RegExp(siteNameSearchMask, 'ig');
  // const stripSiteName = searchString.replace(siteNameRegEx, '');
  // searchString = stripSiteName;

  const stripSpecialChars = searchString.replace(/[&\/\\#,+()$~%.'":*?<>{}|—]/g, ' ').trim();
  searchString = stripSpecialChars;

  return searchString;

}

const getBingImageSearch = async (search: string): Promise<{ results?: Array<any>, error?: any }> => {
  const subscriptionKey = process.env.AZURE_BING_SEARCH_KEY;
  const url = 'https://api.bing.microsoft.com/v7.0/images/search';
  if (search) {
    const config = {
      method : 'GET' as Method,
      url: url + '?q=' + encodeURIComponent(search) + '&aspect=Square',
      headers : {
      'Ocp-Apim-Subscription-Key' : subscriptionKey,
      }
    }
    try {
      const res = await api.request(config);
      return {
        results: res.data.value
      }
    } catch (error) {
      return {
        error: error
      }
    }
  } else {
    return {
      error: "No search string for image"
    }
  }
}

const scrapeMetaTags = async (url: string) => {
  
  let html: any;
  let errors: Array<any> = [];

  try {
    const res = await api(encodeURI(decodeURI(url))); // Recode URI to avoid Error Request path contains unescaped characters
    html = res.data;
  } catch (err: any) {
    if (err.response) {
      // Request made and server responded
      console.log(err.response.data);
      console.log(err.response.status);
      console.log(err.response.headers);
    } else if (err.request) {
      // The request was made but no response was received
      console.log(err.request);
    } else {
      // Something happened in setting up the request that triggered an Error
      console.log('Error', err.message);
    }
    errors.push(err);
  }

  // Additional fallback using stealth puppeteer 
  // For sites such as https://www.fiverr.com/sorich1/fix-bugs-and-build-any-laravel-php-and-vuejs-projects, https://www.netflix.com/gb/title/70136120
  if (!html) {
    try {
      await puppeteer.use(StealthPlugin()).launch().then(async browser => {
        const page = await browser.newPage();;
        await page.goto(url, { waitUntil: 'networkidle0' });
        html = await page.evaluate(() => document.querySelector('*')?.outerHTML);
        await browser.close();
      });
    } catch (err) {
      console.log(err);
      errors.push(err);
    }
  }

  if (html) {

    const $ = cheerio.load(html);
    
    const getMetatag = (name: string) =>  
        $(`meta[name=${name}]`).attr('content') ||  
        $(`meta[name="og:${name}"]`).attr('content') || 
        $(`meta[property="og:${name}"]`).attr('content') ||  
        $(`meta[name="twitter:${name}"]`).attr('content');
  
    return {
      data: {
        url,
        title: $('title').first().text(),
        favicon: $('link[rel="shortcut icon"]').attr('href'),
        // description: $('meta[name=description]').attr('content'),
        description: getMetatag('description'),
        image: getMetatag('image'),
        author: getMetatag('author'),
        siteName: getMetatag('site_name')
      }
    }

  } else {
    return {
      errors: errors
    }
  }

}

const mergeImageUrls = (array1:Array<string>, array2:Array<string>) => {
  let imageUrls:Array<string> = [];
  const l = Math.min(array1.length, array2.length);    
  for (let i = 0; i < l; i++) {
    imageUrls.push(array1[i], array2[i]);
  }
  imageUrls.push(...array1.slice(l), ...array2.slice(l));
  return imageUrls;
}

export default handler;