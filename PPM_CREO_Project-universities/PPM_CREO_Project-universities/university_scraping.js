import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv';

dotenv.config();
// Constants
const WIKIMEDIA_BASE_URL = 'https://commons.wikimedia.org/wiki/Category:Logos_of_universities_and_colleges_in_England';
const WHED_URL = 'https://www.whed.net/home.php';
const OUTPUT_FILES = {
  logos: 'university_logos.json',
  data: 'university_data.json'
};


//supabase setuup with .env
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Shared state for logo data
const visitedPages = new Set();
const scrapedLogoData = [];

/**
 * Recursively scrapes images from Wikimedia pages
 * @param {puppeteer.Browser} browser - Puppeteer browser instance
 * @param {string} pageUrl - URL to scrape
 */
async function scrapeImagesRecursively(browser, pageUrl) {
  if (visitedPages.has(pageUrl)) return;
  
  console.log(`Scraping: ${pageUrl}`);
  visitedPages.add(pageUrl);
  const page = await browser.newPage();
  
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    // Extract images
    const images = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.thumb img')).map(img => ({
        src: img.src,
      }));
    });
    
    console.log(`Found ${images.length} images on ${pageUrl}`);
    
    // Process each image individually
    for (const image of images) {
      scrapedLogoData.push(image);
      //insert logo into supabase immediately
      await addDataToSupabase([image], 'university_logo_table');
    }
    
    // Find internal links for further scraping
    const links = await page.evaluate(baseUrl => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map(link => link.href)
        .filter(href => href.startsWith(baseUrl));
    }, WIKIMEDIA_BASE_URL);
    
    await page.close();
    
    // Recursively process new links
    for (const link of links) {
      await scrapeImagesRecursively(browser, link);
    }
  } catch (error) {
    console.error(`Error scraping ${pageUrl}:`, error);
  } finally {
    if (!page.isClosed()) await page.close();
  }
}
/**
 * Main function to scrape university logos from Wikimedia
 */
async function scrapeUniversityLogos() {
  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: null
  });

  try {
    await scrapeImagesRecursively(browser, WIKIMEDIA_BASE_URL);
    
    // Save results
    await fs.writeFile(
      OUTPUT_FILES.logos, 
      JSON.stringify(scrapedLogoData, null, 2)
    );
    
    console.log(`Logo scraping complete. Data saved to ${OUTPUT_FILES.logos}`);
  } catch (error) {
    console.error('Error in logo scraping:', error);
  } finally {
    await browser.close();
  }
}



/**
 * Scrapes university information from WHED database
 */
async function scrapeUniversityData() {
  const browser = await puppeteer.launch({ 
    headless: true,
    defaultViewport: null,
    args: ['--window-size=1200,800'] // Larger viewport to ensure all elements are visible
  });
  
  const page = await browser.newPage();
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    console.log('Opening WHED website...');
    await page.goto(WHED_URL, { waitUntil: 'domcontentloaded' });
    
    // Select country and search
    await page.waitForSelector('select[name="Chp1"]');
    console.log("Selecting 'United Kingdom' from dropdown...");
    await page.select('select[name="Chp1"]', 'United Kingdom');
    
    // Click the Go button and wait for navigation
    await Promise.all([
      page.click('input[value="Go"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);
    
    console.log('Search completed, starting to scrape results...');
    
    const universities = [];
    let currentPage = 1;
    let hasMorePages = true;
    
    // Process all result pages
    while (hasMorePages) {
      console.log(`Processing page ${currentPage}...`);
      
      // Wait for the university entries to load
      await page.waitForSelector('h3');
      
      // Extract data from the current page using a separate tab for detail pages
      const pageResults = await extractUniversitiesFromCurrentPage(page);
      universities.push(...pageResults);
      
      console.log(`Page ${currentPage}: Extracted ${pageResults.length} universities. Total so far: ${universities.length}`);
      
      // Check for the next page link
      const hasNextPage = await page.evaluate(() => {
        const nextLink = document.querySelector('a.next');
        return !!nextLink;
      });
      
      if (hasNextPage) {
        console.log(`Navigating to page ${currentPage + 1}...`);
        
        // Click the next page link and wait for navigation
        await Promise.all([
          page.click('a.next'),
          page.waitForNavigation({ waitUntil: 'networkidle2' })
        ]);
        
        currentPage++;
      } else {
        console.log('No more pages found. Scraping complete.');
        hasMorePages = false;
      }
    }
    
    // Save results
    await fs.writeFile(
      OUTPUT_FILES.data, 
      JSON.stringify(universities, null, 2)
    );
    
    console.log(`Finished scraping. Total universities scraped: ${universities.length}`);
    return universities;
  } catch (error) {
    console.error('Error in university data scraping:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

/**
 * Extracts university data from the current page
 * @param {puppeteer.Page} page - Puppeteer page instance for the listing page
 * @returns {Promise<Array>} Array of university objects with complete data
 */
async function extractUniversitiesFromCurrentPage(page) {
  // Get all university entries on the current page
  const universityEntries = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('h3')).map(uniBlock => {
      const nameElement = uniBlock.querySelector('a');
      const countryElement = uniBlock.closest('div').querySelector('div[align="right"]');
      const fancyboxLink = uniBlock.querySelector('a.fancybox');
      
      return {
        name: nameElement ? nameElement.innerText.trim() : 'No name found',
        country: countryElement ? countryElement.innerText.trim() : 'No country found',
        fancyboxUrl: fancyboxLink ? fancyboxLink.href : null,
      };
    });
  });
  
  console.log(`Found ${universityEntries.length} universities on current page`);
  
  // Create a new page for detail scraping to avoid navigation issues
  const detailPage = await page.browser().newPage();
  const completeData = [];
  
  try {
    // Process each university detail page
    for (const uni of universityEntries) {
      if (uni.fancyboxUrl) {
        try {
          console.log(`Fetching details for: ${uni.name}`);
          
          // Navigate to the detail page
          await detailPage.goto(uni.fancyboxUrl, { 
            waitUntil: 'networkidle2',
            timeout: 30000 // Increased timeout for potentially slow pages
          });
          
          // Extract the real website URL
          const website = await detailPage.evaluate(() => {
            const lienElement = document.querySelector('a.lien');
            return lienElement ? lienElement.href : 'No website found';
          });
          
          // Create university data object
          const universityData = {
            name: uni.name,
            country: uni.country,
            website: website,
          };
          
          // Add to local array
          completeData.push(universityData);
          
          // Insert into Supabase immediately
          console.log(`Inserting data for ${uni.name} into Supabase...`);
          await addDataToSupabase([universityData]);
          
        } catch (detailError) {
          console.error(`Error processing detail for ${uni.name}:`, detailError.message);
          
          // Add university with error info and insert to Supabase
          const errorData = {
            name: uni.name,
            country: uni.country,
            website: 'Error retrieving website',
          };
          
          completeData.push(errorData);
          console.log(`Inserting error data for ${uni.name} into Supabase...`);
          await addDataToSupabase([errorData]);
        }
      } else {
        // No detail link available
        const noDetailData = {
          name: uni.name,
          country: uni.country,
          website: 'No website found'
        };
        
        completeData.push(noDetailData);
        console.log(`Inserting no-detail data for ${uni.name} into Supabase...`);
        await addDataToSupabase([noDetailData]);
      }
    }
  } finally {
    // Always close the detail page
    await detailPage.close();
  }
  
  return completeData;
}



/**
 * function to add data to the supabase DB
 */
async function addDataToSupabase(scrapedData, tableName = 'university_data_table') {
  try {
    console.log(`Inserting ${scrapedData.length} records into ${tableName}...`);
    
    const { data, error } = await supabase
      .from(tableName)
      .insert(scrapedData);
    
    if (error) {
      console.error(`Error inserting data into ${tableName}:`, error);
      return false;
    }
    
    console.log(`Data inserted successfully into ${tableName}:`, data);
    return true;
  } catch (err) {
    console.error(`Exception when inserting data into ${tableName}:`, err);
    return false;
  }
}
/**
 * Main function to run the scraper
 */
async function main() {
  try {
    // Just run the scraper - data will be inserted to Supabase incrementally
    const uniDataToAdd = await scrapeUniversityLogos();
    
    console.log(`All operations completed successfully. Total universities processed: ${uniDataToAdd.length}`);
  } catch (error) {
    console.error('Error in main execution:', error);
  }
}

// Call the main function
//main();
