import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js'
dotenv.config();

//supabase setuup with .env
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
const WHED_URL = 'https://www.whed.net/home.php';
const OUTPUT_FILE = 'university_other.json';
const NAVIGATION_TIMEOUT = 60000; // Increased to 60 seconds
const MAX_RETRIES = 3;

/**
 * Scrapes European university information from WHED database
 */
async function scrapeEuropeanUniversities() {
  const browser = await puppeteer.launch({ 
    headless: 'new',
    defaultViewport: null,
    args: ['--window-size=1200,800']
  });
  
  const page = await browser.newPage();
  const europeanCountries = [
    'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'United Kingdom',
    'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary',
    'Ireland', 'Italy', 'Latvia', 'Lithuania', 'Luxembourg', 'Malta', 'Netherlands',
    'Poland', 'Portugal', 'Romania', 'Slovakia', 'Slovenia', 'Spain', 'Sweden'
  ];
  
  const universities = [];
  const BATCH_SIZE = 50; // Number of records to insert at once
  
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    for (const country of europeanCountries) {
      console.log(`Processing country: ${country}`);
      
      let retryCount = 0;
      let success = false;
      
      while (retryCount < MAX_RETRIES && !success) {
        try {
          await page.goto(WHED_URL, { 
            waitUntil: 'domcontentloaded',
            timeout: NAVIGATION_TIMEOUT 
          });
          
          await page.waitForSelector('select[name="Chp1"]', { timeout: NAVIGATION_TIMEOUT });
          await page.select('select[name="Chp1"]', country);
          
          await Promise.all([
            page.click('input[value="Go"]'),
            page.waitForNavigation({ 
              waitUntil: 'networkidle2',
              timeout: NAVIGATION_TIMEOUT 
            })
          ]);
          
          success = true;
        } catch (error) {
          retryCount++;
          console.error(`Attempt ${retryCount} failed for ${country}:`, error.message);
          if (retryCount === MAX_RETRIES) {
            console.error(`Failed to process ${country} after ${MAX_RETRIES} attempts`);
            continue;
          }
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      
      if (!success) continue;
      
      let currentPage = 1;
      let hasMorePages = true;
      
      while (hasMorePages) {
        console.log(`Processing page ${currentPage} for ${country}...`);
        
        try {
          await page.waitForSelector('h3', { timeout: NAVIGATION_TIMEOUT });
          
          const pageResults = await extractUniversitiesFromCurrentPage(page);
          universities.push(...pageResults);
          
          console.log(`Page ${currentPage}: Extracted ${pageResults.length} universities. Total so far: ${universities.length}`);
          
          // If we have enough records for a batch, insert them
          if (universities.length >= BATCH_SIZE) {
            const batchToInsert = universities.splice(0, BATCH_SIZE);
            console.log(`Inserting batch of ${batchToInsert.length} universities...`);
            await addDataToSupabase(batchToInsert);
          }
          
          const hasNextPage = await page.evaluate(() => {
            const nextLink = document.querySelector('a.next');
            return !!nextLink;
          });
          
          if (hasNextPage) {
            await Promise.all([
              page.click('a.next'),
              page.waitForNavigation({ 
                waitUntil: 'networkidle2',
                timeout: NAVIGATION_TIMEOUT 
              })
            ]);
            currentPage++;
          } else {
            hasMorePages = false;
          }
        } catch (error) {
          console.error(`Error processing page ${currentPage} for ${country}:`, error.message);
          hasMorePages = false;
        }
      }
      
      // Insert any remaining universities for this country
      if (universities.length > 0) {
        console.log(`Inserting remaining ${universities.length} universities for ${country}...`);
        await addDataToSupabase(universities);
        universities.length = 0; // Clear the array after insertion
      }
    }
    
    console.log('Finished scraping and inserting all universities');
    return true;
  } catch (error) {
    console.error('Error in university data scraping:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

/**
 * Extracts university data from the current page
 * @param {puppeteer.Page} page - Puppeteer page instance
 * @returns {Promise<Array>} Array of university objects
 */
async function extractUniversitiesFromCurrentPage(page) {
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
            timeout: NAVIGATION_TIMEOUT
          });
          
          // Extract the website URL and city
          const details = await detailPage.evaluate(() => {
            const lienElement = document.querySelector('a.lien');
            
            // Try multiple approaches to find the city
            let city = 'No city found';
            
            // Approach 1: Direct span.contenu after City: label
            const citySpans = Array.from(document.querySelectorAll('span.contenu'));
            for (const span of citySpans) {
              const prevElement = span.previousElementSibling;
              if (prevElement && prevElement.classList.contains('libelle') && prevElement.textContent.includes('City:')) {
                city = span.textContent.trim();
                break;
              }
            }
            
            // Approach 2: Look for any span containing city information
            if (city === 'No city found') {
              const allSpans = Array.from(document.querySelectorAll('span'));
              for (const span of allSpans) {
                if (span.textContent.includes('City:')) {
                  const nextSpan = span.nextElementSibling;
                  if (nextSpan) {
                    city = nextSpan.textContent.trim();
                    break;
                  }
                }
              }
            }
            
            // Log the HTML structure for debugging
            console.log('Page HTML structure:', document.body.innerHTML);
            
            return {
              website: lienElement ? lienElement.href : 'No website found',
              city: city
            };
          });
          
          console.log(`Extracted details for ${uni.name}:`, details);
          
          // Create university data object
          const universityData = {
            name: uni.name,
            city: details.city,
            country: uni.country,
            website: details.website,
            institution_type: 'University'
          };
          
          // Add to local array
          completeData.push(universityData);
          
        } catch (detailError) {
          console.error(`Error processing detail for ${uni.name}:`, detailError.message);
          
          // Add university with error info
          const errorData = {
            name: uni.name,
            country: uni.country,
            city: 'Error retrieving city',
            website: 'Error retrieving website',
            institution_type: 'University'
          };
          
          completeData.push(errorData);
        }
      } else {
        // No detail link available
        const noDetailData = {
          name: uni.name,
          country: uni.country,
          city: 'No city found',
          website: 'No website found',
          institution_type: 'University'
        };
        
        completeData.push(noDetailData);
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
async function addDataToSupabase(scrapedData, tableName = 'universities_other') {
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

// Run the scraper
scrapeEuropeanUniversities()
  .then(() => console.log('Scraping completed successfully'))
  .catch(error => console.error('Scraping failed:', error)); 